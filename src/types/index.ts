export type Flat = { [key: string]: string };
export type FileWithContent = {
    path: string;
    content: Buffer;
    hash: string;
}
export type SnapshotChanges = {
    added: { [key: string]: string; }
    modified: { [key: string]: string;}
    deleted: string[];
}
export type Snapshot = {
    id: number;
    date: string;
    parent: number | null;
    changes: SnapshotChanges;
}