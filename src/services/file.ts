import fs from 'fs';
import path from 'path';
import crypto, { BinaryLike } from "crypto";
import { Flat, Snapshot, SnapshotChanges, FileWithContent } from "../types";

//default directory if not passed in at construction
const DB_DIR = ".mydb";

export default class FileService {
    private DB_DIR: string;
    private BLOBS_DIR: string;
    private SNAP_DIR: string;
    private snapshotCache: Map<number, Snapshot> = new Map();
    private flatCache: Map<number, Flat> = new Map();
    private blobPresenceCache: Map<string, boolean> = new Map();
    private blobSizeCache = new Map<string, number>();

    constructor(options?: { DB_DIR?: string }) {
        this.DB_DIR = DB_DIR;
        if (options?.DB_DIR) {
            this.DB_DIR = options.DB_DIR;
        }
        this.BLOBS_DIR = path.join(this.DB_DIR, "blobs");
        this.SNAP_DIR = path.join(this.DB_DIR, "snapshots");
        this.ensureDirsExist();
    }

    hashContent(content: BinaryLike): string {
        return crypto.createHash("sha256").update(content).digest("hex");
    }

    storeBlob(content: BinaryLike): string {
        const hash: string = this.hashContent(content);
        const subdir: string = path.join(this.BLOBS_DIR, hash.slice(0, 2));
        const filePath: string = path.join(subdir, hash.slice(2));

        try {
            // Try to create the directory if it doesn't exist
            if (!fs.existsSync(subdir)) {
                fs.mkdirSync(subdir, { recursive: true });
            }
            // Use 'wx' flag to write only if file doesn't exist
            fs.writeFileSync(filePath, content, { flag: 'wx' });
        } catch (error: unknown) {
            // Type guard to check if the error has a code property
            if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
                // Ignore EEXIST error (file already exists)
                return hash;
            }
            // Re-throw other errors
            throw error;
        }
        return hash;
    }

    async loadContent(hash: string): Promise<Buffer> {
        const subdir: string = path.join(this.BLOBS_DIR, hash.slice(0, 2));
        const filePath: string = path.join(subdir, hash.slice(2));
        return fs.promises.readFile(filePath);
    }

    private flattenDirWithContent(dirPath: string, prefix: string = ""): [Flat, FileWithContent[]] {
        const flat: Flat = {};
        const filesWithContent: FileWithContent[] = [];
        const entries = fs.readdirSync(dirPath);
        
        for (const entry of entries) {
            const fullPath: string = path.join(dirPath, entry);
            const relPath: string = prefix ? `${prefix}/${entry}` : entry;
            const stat: fs.Stats = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                const [subFlat, subFiles] = this.flattenDirWithContent(fullPath, relPath);
                Object.assign(flat, subFlat);
                filesWithContent.push(...subFiles);
            } else {
                const content = fs.readFileSync(fullPath);
                const hash = this.hashContent(content as unknown as BinaryLike);
                flat[relPath] = hash;
                filesWithContent.push({ path: relPath, content, hash });
            }
        }
        
        return [flat, filesWithContent];
    }
    
    flattenDir(dirPath: string, prefix: string = ""): Flat {
        const [flat] = this.flattenDirWithContent(dirPath, prefix);
        return flat;
    }

    lastSnapshotId(): number | null {
        const files: string[] = fs.readdirSync(this.SNAP_DIR);
        if (files.length === 0) return null;
        return Math.max(...files.map(f => parseInt(f)));
    }

    async loadSnapshot(id: number): Promise<Snapshot> {
        //handles an edge case where the snapshot file does not exist (manual deletion)
        if (fs.existsSync(path.join(this.SNAP_DIR, `${id}.json`)) === false) {
            return { id, date: "", parent: null, changes: { added: {}, modified: {}, deleted: [] } };
        }

        //reg case
        const filePath: string = path.join(this.SNAP_DIR, `${id}.json`);
        return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    }

    async saveSnapshot(snapshot: Snapshot): Promise<void> {
        const filePath: string = path.join(this.SNAP_DIR, `${snapshot.id}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify(snapshot, null, 2));
    }

    async createSnapshot(dirPath: string): Promise<Snapshot> {
        const [flat, filesWithContent] = this.flattenDirWithContent(dirPath);
        let parent: Snapshot | null = null;
        let parentFlat: Flat = {};
        const lastId: number | null = this.lastSnapshotId();
        if (lastId) {
            parent = await this.loadSnapshot(lastId);
            parentFlat = await this.reconstructSnapshot(parent.id);
        }

        const newId: number = lastId ? lastId + 1 : 1;
        const snapshot: Snapshot = { id: newId, parent: parent?.id || null, date: new Date().toISOString(), changes: { added: {}, modified: {}, deleted: [] } };
        const changes: SnapshotChanges = { added: {}, modified: {}, deleted: [] };
        
        // Process added and modified files
        await Promise.all(
            filesWithContent.map(async ({ path: pathKey, content, hash }) => {
                // Only store the blob if it doesn't already exist
                const blobPath = this.blobPath(hash);
                if (!fs.existsSync(blobPath)) {
                    await this.storeBlob(content as unknown as BinaryLike);
                }
                
                if (!(pathKey in parentFlat)) {
                    changes.added[pathKey] = hash;
                } else if (parentFlat[pathKey] !== hash) {
                    changes.modified[pathKey] = hash;
                }
            })
        );

        // Track Deleted
        await Promise.all(
            Object.keys(parentFlat).map(async (pathKey) => {
                if (!(pathKey in flat)) {
                    changes.deleted.push(pathKey);
                }
            })
        );
        snapshot.changes = changes;

        await this.saveSnapshot(snapshot);

        return snapshot;
    }

    private async loadSnapshotWithCache(id: number): Promise<Snapshot> {
        if (this.snapshotCache.has(id)) {
            return this.snapshotCache.get(id)!;
        }
        try {
            const snapPath = path.join(this.SNAP_DIR, `${id}.json`);
            const data = await fs.promises.readFile(snapPath, 'utf8');
            const snapshot = JSON.parse(data);
            this.snapshotCache.set(id, snapshot);
            return snapshot;
        } catch (error) {
            throw new Error(`Failed to load snapshot ${id}: ${error}`);
        }
    }

    async reconstructSnapshot(id: number): Promise<Flat> {
        if (this.flatCache.has(id)) {
            return this.flatCache.get(id)!;
        }
        
        const snapshotChain: Snapshot[] = [];
        let currentId: number | null = id;
        
        // Build the snapshot chain
        while (currentId !== null) {
            const snap: Snapshot = await this.loadSnapshotWithCache(currentId);
            snapshotChain.unshift(snap);
            currentId = snap.parent;
        }
        
        // Reconstruct the flat state by applying each snapshot in order
        const flat: Flat = {};
        for (const snap of snapshotChain) {
            // Apply added and modified changes
            for (const [key, hash] of Object.entries(snap.changes.added)) {
                flat[key] = hash;
            }
            for (const [key, hash] of Object.entries(snap.changes.modified)) {
                flat[key] = hash;
            }
            // Apply deletions
            for (const key of snap.changes.deleted) {
                delete flat[key];
            }
            // Cache the result for each snapshot in the chain
            // Cache the result at each level
            this.flatCache.set(snap.id, { ...flat });
        }

        return flat;
    }

    async restoreSnapshot(id: number, targetDir: string): Promise<void> {
        const flat: Flat = await this.reconstructSnapshot(id);
        // Ensure target directory exists
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        // Process each file in the snapshot
        for (const [relPath, hash] of Object.entries(flat)) {
            try {
                const content: Buffer = await this.loadContent(hash);
                const outPath: string = path.join(targetDir, relPath);
                const dirPath = path.dirname(outPath);
                
                // Ensure the directory exists
                if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, { recursive: true });
                }

                // Write the file
                await fs.promises.writeFile(outPath, content as unknown as Uint8Array);
            } catch (error) {
                console.error(`Error restoring file ${relPath}:`, error);
                throw error;
            }
        }
    }

    async listSnapshots(): Promise<Snapshot[]> {
        const files: string[] = fs.readdirSync(this.SNAP_DIR);
        const snapshots: Snapshot[] = await Promise.all(files.map(async file => {
            const id = parseInt(path.basename(file, '.json'));
            const snapshot = await this.loadSnapshot(id);
            return { ...snapshot, id, };
        }));
        return snapshots.sort((a, b) => a.id - b.id);
    }

    private async *getAllUsedBlobs(): AsyncIterableIterator<string> {
        // Process snapshots one at a time to reduce memory usage
        for (const file of fs.readdirSync(this.SNAP_DIR)) {
            const id = parseInt(path.basename(file, '.json'));
            if (isNaN(id)) continue;
            
            const snapshot = await this.loadSnapshot(id);
            for (const hash of this.blobsInSnapshot(snapshot)) {
                yield hash;
            }
        }
    }

    async pruneSnapshot(id: number): Promise<void> {
        const snapshot: Snapshot = await this.loadSnapshot(id);
        if (snapshot.date === "") {
            throw new Error(`Snapshot with ID ${id} does not exist.`);
        }

        // Remap the next snapshot to point to the previous parent
        const nextSnapshot: Snapshot | null = await this.loadSnapshot(id + 1);
        if (nextSnapshot && nextSnapshot.parent === id) {
            nextSnapshot.parent = snapshot.parent;
            this.saveSnapshot(nextSnapshot);
        }

        // Remove the snapshot file
        const filePath = path.join(this.SNAP_DIR, `${id}.json`);
        fs.unlinkSync(filePath);

        // Process blobs in use using a Set for O(1) lookups
        const usedBlobs = new Set<string>();
        for await (const hash of this.getAllUsedBlobs()) {
            usedBlobs.add(hash);
        }

        // Process blob directories
        for (const subdir of fs.readdirSync(this.BLOBS_DIR)) {
            const subdirPath = path.join(this.BLOBS_DIR, subdir);
            const stat = fs.lstatSync(subdirPath);
            
            if (!stat.isDirectory()) {
                continue;
            }

            let isEmpty = true;
            const entries = fs.readdirSync(subdirPath);
            
            // Process files in the subdirectory
            for (const file of entries) {
                const fullHash = subdir + file;
                const filePath = path.join(subdirPath, file);
                
                try {
                    if (!usedBlobs.has(fullHash)) {
                        fs.unlinkSync(filePath);
                    } else {
                        // If we find at least one used file, the directory isn't empty
                        isEmpty = false;
                    }
                } catch (error) {
                    console.warn(`Failed to process blob ${filePath}:`, error);
                }
            }

            // Clean up empty directories
            if (isEmpty) {
                try {
                    fs.rmdirSync(subdirPath);
                } catch (error) {
                    console.warn(`Failed to remove directory ${subdirPath}:`, error);
                }
            }
        }
    }

    async directoryExists(directoryPath: string): Promise<boolean> {
        try {
            const stat = await fs.promises.stat(directoryPath);
            return stat.isDirectory();
        } catch (error) {
            return false;
        }
    }

    async ensureDirsExist(): Promise<void> {
        const dirs = [this.DB_DIR, this.BLOBS_DIR, this.SNAP_DIR];
        for (const dir of dirs) {
            try {
                await fs.promises.mkdir(dir, { recursive: true });
            } catch (error:any) {
                // Ignore error if directory already exists
                if (error.code !== 'EEXIST') {
                    throw error;
                }
            }
        }
    }

    async dbSize(): Promise<number> {
        try {
            const subdirs = await fs.promises.readdir(this.BLOBS_DIR);
            let total = 0;
            
            for (const sub of subdirs) {
                const files = await fs.promises.readdir(path.join(this.BLOBS_DIR, sub));
                const sizes = await Promise.all(
                    files.map(file => 
                        fs.promises.stat(path.join(this.BLOBS_DIR, sub, file))
                            .then(stat => stat.size)
                            .catch(() => 0)
                    )
                );
                total += sizes.reduce((sum, size) => sum + size, 0);
            }
            return total;
        } catch (error) {
            return 0;
        }
    }

    async logicalSize(snapshotId: number): Promise<number> {
        const flat: Flat = await this.reconstructSnapshot(snapshotId);
        let total: number = 0;
        for (const key of Object.values(flat)) {
            total += await this.blobSize(key);
        }
        return total;
    }

    async blobSize(hash: string): Promise<number> {
        if (this.blobSizeCache.has(hash)) {
            return this.blobSizeCache.get(hash)!;
        }
        try {
            const size = (await fs.promises.stat(this.blobPath(hash))).size;
            this.blobSizeCache.set(hash, size);
            return size;
        } catch (error) {
            return 0; // Return 0 for missing blobs
        }
    }

    blobPath(hash: string): string {
        return path.join(this.BLOBS_DIR, hash.slice(0, 2), hash.slice(2));
    }

    blobsInSnapshot(snap: Snapshot): string[] {
        return [
            ...Object.values(snap.changes.added),
            ...Object.values(snap.changes.modified),
        ];
    }

    
    async seenBefore(hash: string, snapshot: Snapshot): Promise<boolean> {
        const cacheKey = `${hash}-${snapshot.id}`;
        
        // Check cache first
        if (this.blobPresenceCache.has(cacheKey)) {
            return this.blobPresenceCache.get(cacheKey)!;
        }
        
        // Check current snapshot first (most likely to have recent changes)
        if (this.blobsInSnapshot(snapshot).includes(hash)) {
            this.blobPresenceCache.set(cacheKey, true);
            return true;
        }
        
        // Then check parent chain
        let current: number | null = snapshot.parent;
        while (current) {
            const parent = await this.loadSnapshotWithCache(current);
            const parentBlobs = this.blobsInSnapshot(parent);
            
            // Cache results for parent snapshots as we go
            const parentCacheKey = `${hash}-${parent.id}`;
            const isPresent = parentBlobs.includes(hash);
            this.blobPresenceCache.set(parentCacheKey, isPresent);
            
            if (isPresent) {
                this.blobPresenceCache.set(cacheKey, true);
                return true;
            }
            
            current = parent.parent;
        }
        
        this.blobPresenceCache.set(cacheKey, false);
        return false;
    }
    
    async physicalSize(snapshotId: number): Promise<number> {
        try {
            const snap = await this.loadSnapshot(snapshotId);
            const blobs = this.blobsInSnapshot(snap);
            let totalSize = 0;
            
            // For each blob in this snapshot, check if it's referenced by any parent snapshots
            for (const hash of blobs) {
                let isUnique = true;
                let currentSnap = snap;
                
                // Check parent snapshots for this blob
                while (currentSnap.parent !== null) {
                    const parent = await this.loadSnapshot(currentSnap.parent);
                    const parentBlobs = this.blobsInSnapshot(parent);
                    
                    if (parentBlobs.includes(hash)) {
                        isUnique = false;
                        break;
                    }
                    currentSnap = parent;
                }
                
                if (isUnique) {
                    totalSize += await this.blobSize(hash);
                }
            }
            
            return totalSize;
        } catch (error) {
            console.error(`Error calculating physical size for snapshot ${snapshotId}:`, error);
            return 0;
        }
    }
}