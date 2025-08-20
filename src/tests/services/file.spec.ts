import fs from "fs";
import path from "path";
import FileService from "../../services/file"; 
import { Flat, Snapshot } from "../../types";

const TMP_DIR: string = "tmp_test";
const DB_DIR: string = ".tmp_test_db";

const fileService = new FileService({
  DB_DIR
});

// Helpers
function writeFile(relPath:string, content:string) {
  const full: string = path.join(TMP_DIR, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  fileService.ensureDirsExist();
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  fs.rmSync('restored', { recursive: true, force: true });
});

describe("FileService", () => {
  it("creates a snapshot with added files", () => {
    writeFile("a.txt", "hello");
    writeFile("b.txt", "world");

    const snap1: Snapshot = fileService.createSnapshot(TMP_DIR);

    const flat: Flat = fileService.reconstructSnapshot(snap1.id);
    expect(Object.keys(flat).sort()).toEqual(["a.txt", "b.txt"]);
    expect(fileService.loadContent(flat["a.txt"]).toString()).toBe("hello");
  });

  it("detects modifications to a file", () => {
    writeFile("a.txt", "hello");
    const snap1: Snapshot = fileService.createSnapshot(TMP_DIR);

    writeFile("a.txt", "HELLO"); // modified
    const snap2: Snapshot = fileService.createSnapshot(TMP_DIR);

    const flat2: Flat = fileService.reconstructSnapshot(snap2.id);
    expect(fileService.loadContent(flat2["a.txt"]).toString()).toBe("HELLO");

    // Ensure different hash from snap1
    expect(flat2["a.txt"]).not.toBe(fileService.reconstructSnapshot(snap1.id)["a.txt"]);
  });

  it("detects deletions to a file", () => {
    writeFile("a.txt", "x");
    writeFile("b.txt", "y");
    fileService.createSnapshot(TMP_DIR);

    fs.rmSync(path.join(TMP_DIR, "b.txt"));
    const snap2: Snapshot = fileService.createSnapshot(TMP_DIR);

    const flat2: Flat = fileService.reconstructSnapshot(snap2.id);
    expect(Object.keys(flat2)).toEqual(["a.txt"]);
    expect(flat2["b.txt"]).toBeUndefined();
  });

  it("restores snapshot correctly", () => {
    writeFile("a.txt", "foo");
    const snap1: Snapshot = fileService.createSnapshot(TMP_DIR);

    const restoreDir: string = "restored";
    fs.rmSync(restoreDir, { recursive: true, force: true });
    fileService.restoreSnapshot(snap1.id, restoreDir);

    const content: string = fs.readFileSync(path.join(restoreDir, "a.txt"), "utf8");
    expect(content).toBe("foo");
  });

  it("calculates sizes correctly", () => {
    writeFile("a.txt", "12345");  // 5 bytes
    const snap1: Snapshot = fileService.createSnapshot(TMP_DIR);

    writeFile("a.txt", "1234567890"); // 10 bytes
    const snap2: Snapshot = fileService.createSnapshot(TMP_DIR);

    const logical1: number = fileService.logicalSize(snap1.id);
    const logical2: number = fileService.logicalSize(snap2.id);

    expect(logical1).toBe(5);   // restore snapshot1 = 5 bytes
    expect(logical2).toBe(10);  // restore snapshot2 = 10 bytes

    const unique1: number = fileService.physicalSize(snap1.id);
    const unique2: number = fileService.physicalSize(snap2.id);

    expect(unique1).toBe(5);
    expect(unique2).toBe(10);

    // Database should have 15 total (5 + 10, both unique blobs)
    expect(fileService.dbSize()).toBe(15);
  });

  it("reuses identical content", () => {
    writeFile("a.txt", "dup");
    fileService.createSnapshot(TMP_DIR);

    writeFile("b.txt", "dup"); // same content as a.txt
    const snap2: Snapshot = fileService.createSnapshot(TMP_DIR);

    const flat2: Flat = fileService.reconstructSnapshot(snap2.id);
    expect(flat2["a.txt"]).toBe(flat2["b.txt"]); // same hash

    // Unique cost of snap2 should be 0, since no new blob introduced
    expect(fileService.physicalSize(snap2.id)).toBe(0);
  });
});