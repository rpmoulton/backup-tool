import FileService from "./file";
export default class CommandService {
    private fileService: FileService;

    constructor() {
        this.fileService = new FileService();
    }

    async handleSnapshot(target: string): Promise<void> {
        try {
            await this.fileService.createSnapshot(target);
            console.log(`Snapshot created for target: ${target}`);
        } catch (error: any) {
            console.error(`Error creating snapshot: ${error.message}`);
        }
    }

    async handleList(): Promise<void> {
        try {
            const snapshots = await this.fileService.listSnapshots();
            console.log("Snapshots:");
            if (snapshots.length === 0) {
                console.log("No snapshots found.");
                return;
            }
            snapshots.forEach(async (snap: any) => {
                console.log(`ID: ${snap.id}, TIMESTAMP: ${snap.date}, SIZE: ${await this.fileService.logicalSize(snap.id)} KB, DISTINCT: ${await this.fileService.physicalSize(snap.id)} KB`);
            });
            console.log(`Total size: ${await this.fileService.dbSize()} KB`);
        } catch (error: any) {
            console.error(`Error pruning snapshot: ${error.message}`);
        }
    }

    async handleRestore(id: string, target: string): Promise<void> {
        try {
            await this.fileService.restoreSnapshot(parseInt(id), target);
            console.log(`Snapshot ${id} restored to target: ${target}`)
        } catch (error: any) {
            console.error(`Error restoring snapshot: ${error.message}`);
        }
    }

    async handlePrune(id: string): Promise<void> {
        try {
            await this.fileService.pruneSnapshot(parseInt(id));
            console.log(`Snapshot ${id} pruned successfully.`)
        } catch (error: any) {
            console.error(`Error pruning snapshot: ${error.message}`);
        }
    }
}