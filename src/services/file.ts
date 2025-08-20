import fs from 'fs';
import path from 'path';
import crypto, { BinaryLike } from "crypto";
import { Flat, Snapshot, SnapshotChanges } from "../types";

//default directory if not passed in at construction
const DB_DIR = ".mydb";

export default class FileService {
    private DB_DIR: string;
    private BLOBS_DIR: string;
    private SNAP_DIR: string;

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

        if (!fs.existsSync(filePath)) {
            fs.mkdirSync(subdir, { recursive: true });
            fs.writeFileSync(filePath, content);
        }
        return hash;
    }

    loadContent(hash: string): Uint8Array {
        const subdir: string = path.join(this.BLOBS_DIR, hash.slice(0, 2));
        const filePath: string = path.join(subdir, hash.slice(2));
        return fs.readFileSync(filePath) as unknown as Uint8Array;
    }

    flattenDir(dirPath: string, prefix: string = ""): Flat {
        let flat: Flat = {};
        for (const entry of fs.readdirSync(dirPath)) {
            const fullPath: string = path.join(dirPath, entry);
            const relPath: string = prefix ? `${prefix}/${entry}` : entry;
            const stat: fs.Stats = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                flat = { ...flat, ...this.flattenDir(fullPath, relPath) };
            } else {
                flat[relPath] = this.hashContent(fs.readFileSync(fullPath) as unknown as BinaryLike);
            }
        }
        return flat;
    }

    lastSnapshotId(): number | null {
        const files: string[] = fs.readdirSync(this.SNAP_DIR);
        if (files.length === 0) return null;
        return Math.max(...files.map(f => parseInt(f)));
    }

    loadSnapshot(id: number): Snapshot {
        //handles an edge case where the snapshot file does not exist (manual deletion)
        if (fs.existsSync(path.join(this.SNAP_DIR, `${id}.json`)) === false) {
            return { id, date: "", parent: null, changes: { added: {}, modified: {}, deleted: [] } };
        }

        //reg case
        const filePath: string = path.join(this.SNAP_DIR, `${id}.json`);
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    saveSnapshot(snapshot: Snapshot): void {
        const filePath: string = path.join(this.SNAP_DIR, `${snapshot.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    }

    createSnapshot(dirPath: string): Snapshot {
        const flat: Flat = this.flattenDir(dirPath);
        let parent: Snapshot | null = null;
        let parentFlat: Flat = {};
        const lastId: number | null = this.lastSnapshotId();
        if (lastId) {
            parent = this.loadSnapshot(lastId);
            parentFlat = this.reconstructSnapshot(parent.id);
        }

        const newId: number = lastId ? lastId + 1 : 1;
        const snapshot: Snapshot = { id: newId, parent: parent?.id || null, date: new Date().toISOString(), changes: { added: {}, modified: {}, deleted: [''] } };
        const changes: SnapshotChanges = { added: {}, modified: {}, deleted: [] };

        // Track Added/modified
        for (const [pathKey, content] of Object.entries(flat)) {
            const hash: string = this.storeBlob(fs.readFileSync(path.join(dirPath, pathKey)) as unknown as BinaryLike);
            if (!(pathKey in parentFlat)) {
                changes.added[pathKey] = hash;
            } else {
                const oldHash: string = this.hashContent(parentFlat[pathKey]);
                if (oldHash !== hash) {
                    changes.modified[pathKey] = hash;
                }
            }
        }

        // Track Deleted
        for (const pathKey of Object.keys(parentFlat)) {
            if (!(pathKey in flat)) {
                changes.deleted.push(pathKey);
            }
        }
        snapshot.changes = changes;

        this.saveSnapshot(snapshot);

        return snapshot;
    }

    reconstructSnapshot(id: number): Flat {
        const snap: Snapshot = this.loadSnapshot(id);
        let flat: Flat = {};
        if (snap.parent) {
            flat = this.reconstructSnapshot(snap.parent);
        }
        for (const [key, hash] of Object.entries(snap.changes.added)) {
            flat[key] = hash;
        }
        for (const [key, hash] of Object.entries(snap.changes.modified)) {
            flat[key] = hash;
        }
        for (const key of snap.changes.deleted) {
            delete flat[key];
        }

        return flat;
    }

    restoreSnapshot(id: number, targetDir: string): void {
        const flat: Flat = this.reconstructSnapshot(id);
        for (const [relPath, hash] of Object.entries(flat)) {
            const content: Uint8Array = this.loadContent(hash);
            const outPath: string = path.join(targetDir, relPath);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, content);
        }
    }

    listSnapshots(): Snapshot[] {
        const files: string[] = fs.readdirSync(this.SNAP_DIR);
        return files.map(file => {
            const id = parseInt(path.basename(file, '.json'));
            const snapshot = this.loadSnapshot(id);
            return { ...snapshot, id, };
        }).sort((a, b) => a.id - b.id);
    }

    pruneSnapshot(id: number): void {
        const snapshot: Snapshot = this.loadSnapshot(id);
        if (snapshot.date === "") {
            throw new Error(`Snapshot with ID ${id} does not exist.`);
        }

        //remap the next snapshot to point to the previous parent.
        const nextSnapshot: Snapshot | null = this.loadSnapshot(id + 1);
        if (nextSnapshot && nextSnapshot.parent === id) {
            nextSnapshot.parent = snapshot.parent;
            this.saveSnapshot(nextSnapshot);  
        }

        // Remove the snapshot file
        const filePath = path.join(this.SNAP_DIR, `${id}.json`);
        fs.unlinkSync(filePath);

        // Get blobs still in use
        const allSnapshots: Snapshot[] = this.listSnapshots();
        const usedBlobs: Set<string> = new Set();
        allSnapshots.forEach((snap: Snapshot) => {
            this.blobsInSnapshot(snap).forEach((blobHash: string) => {
                usedBlobs.add(blobHash)
            });
        });

        // Remove unused blobs
        for (const subdir of fs.readdirSync(this.BLOBS_DIR)) {
            const subdirPath = path.join(this.BLOBS_DIR, subdir);
            if (!fs.lstatSync(subdirPath).isDirectory()) continue;

            for (const file of fs.readdirSync(subdirPath)) {
                const fullHash: string = subdir + file;
                const filePath: string = path.join(subdirPath, file);

                if (!usedBlobs.has(fullHash)) {
                    fs.unlinkSync(filePath);
                }
            }

            // clean up empty directories
            if (fs.readdirSync(subdirPath).length === 0) {
                fs.rmdirSync(subdirPath);
            }
        }
    }

    directoryExists(directoryPath: string): boolean {
        return fs.existsSync(directoryPath) && fs.lstatSync(directoryPath).isDirectory();
    }

    ensureDirsExist(): void {
        [this.DB_DIR, this.BLOBS_DIR, this.SNAP_DIR].forEach(d => {
            if (!this.directoryExists(d)) fs.mkdirSync(d, { recursive: true });
        });
    }

    dbSize(): number {
        let total: number = 0;
        const subdirs: string[] = fs.readdirSync(this.BLOBS_DIR);
        for (const sub of subdirs) {
            const files: string[] = fs.readdirSync(path.join(this.BLOBS_DIR, sub));
            for (const file of files) {
                const filePath = path.join(this.BLOBS_DIR, sub, file);
                total += fs.statSync(filePath).size;
            }
        }
        return total;
    }

    logicalSize(snapshotId: number): number {
        const flat: Flat = this.reconstructSnapshot(snapshotId);
        let total: number = 0;
        for (const key of Object.values(flat)) {
            total += this.blobSize(key);
        }
        return total;
    }

    blobSize(hash: string): number {
        return fs.statSync(this.blobPath(hash)).size;
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

    seenBefore(hash: string, snapshot: Snapshot): boolean {
        let current: number | null = snapshot.parent;
        while (current) {
            const parent: Snapshot = this.loadSnapshot(current);
            if (this.blobsInSnapshot(parent).includes(hash)) {
                return true;
            }
            current = parent.parent;
        }
        return false;
    }
    
    physicalSize(snapshotId: number): number {
        const snap: Snapshot = this.loadSnapshot(snapshotId);
        let total: number = 0;
        for (const hash of this.blobsInSnapshot(snap)) {
            if (!this.seenBefore(hash, snap)) {
                total += this.blobSize(hash);
            }
        }
        return total;
    }
}