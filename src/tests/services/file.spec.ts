import fs from "fs";
import path from "path";
import FileService from "../../services/file"; 
import { Flat, Snapshot } from "../../types";

const TMP_DIR: string = "tmp_test";
const DB_DIR: string = ".tmp_test_db";

let fileService: FileService;

// Helpers
function writeFile(relPath:string, content:string) {
  const full: string = path.join(TMP_DIR, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(async () => {
  // Clean up any existing test directories
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  fs.rmSync('restored', { recursive: true, force: true });

  // Create fresh test directories
  fs.mkdirSync(TMP_DIR, { recursive: true });
  
  fileService = new FileService({
    DB_DIR
  });
  await fileService.ensureDirsExist();
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  fs.rmSync('restored', { recursive: true, force: true });
});

describe("FileService", () => {
  it("creates a snapshot with added files", async () => {
    writeFile("a.txt", "hello");
    writeFile("b.txt", "world");

    const snap1: Snapshot = await fileService.createSnapshot(TMP_DIR);

    const flat: Flat = await fileService.reconstructSnapshot(snap1.id);
    expect(Object.keys(flat).sort()).toEqual(["a.txt", "b.txt"]);
    const content = await fileService.loadContent(flat["a.txt"]);
    expect(content.toString()).toBe("hello");
  });

  it("detects modifications to a file", async () => {
    writeFile("a.txt", "hello");
    const snap1: Snapshot = await fileService.createSnapshot(TMP_DIR);

    writeFile("a.txt", "HELLO"); // modified
    const snap2: Snapshot = await fileService.createSnapshot(TMP_DIR);

    const flat2: Flat = await fileService.reconstructSnapshot(snap2.id);
    const content2 = await fileService.loadContent(flat2["a.txt"]);
    expect(content2.toString()).toBe("HELLO");

    const reconstructed = await fileService.reconstructSnapshot(snap1.id);
    // Ensure different hash from snap1
    expect(flat2["a.txt"]).not.toBe(reconstructed["a.txt"]);
  });

  it("detects deletions to a file", async () => {
    writeFile("a.txt", "x");
    writeFile("b.txt", "y");
    await fileService.createSnapshot(TMP_DIR);

    fs.rmSync(path.join(TMP_DIR, "b.txt"));
    const snap2: Snapshot = await fileService.createSnapshot(TMP_DIR);

    const flat2: Flat = await fileService.reconstructSnapshot(snap2.id);
    expect(Object.keys(flat2)).toEqual(["a.txt"]);
    expect(flat2["b.txt"]).toBeUndefined();
  });

  it("restores snapshot correctly", async () => {
    writeFile("a.txt", "foo");
    const snap1: Snapshot = await fileService.createSnapshot(TMP_DIR);

    const restoreDir: string = "restored";
    fs.rmSync(restoreDir, { recursive: true, force: true });
    await fileService.restoreSnapshot(snap1.id, restoreDir);

    const content: string = fs.readFileSync(path.join(restoreDir, "a.txt"), "utf8");
    expect(content).toBe("foo");
  });

  it("calculates sizes correctly", async () => {
    writeFile("a.txt", "12345");  // 5 bytes
    const snap1: Snapshot = await fileService.createSnapshot(TMP_DIR);

    writeFile("a.txt", "1234567890"); // 10 bytes
    const snap2: Snapshot = await fileService.createSnapshot(TMP_DIR);

    const logical1: number = await fileService.logicalSize(snap1.id);
    const logical2: number = await fileService.logicalSize(snap2.id);

    expect(logical1).toBe(5);   // restore snapshot1 = 5 bytes
    expect(logical2).toBe(10);  // restore snapshot2 = 10 bytes

    const unique1: number = await fileService.physicalSize(snap1.id);
    const unique2: number = await fileService.physicalSize(snap2.id);

    expect(unique1).toBe(5);
    expect(unique2).toBe(10);

    // Database should have 15 total (5 + 10, both unique blobs)
    expect(await fileService.dbSize()).toBe(15);
  });

  it("reuses identical content", async () => {
    writeFile("a.txt", "dup");
    await fileService.createSnapshot(TMP_DIR);

    writeFile("b.txt", "dup"); // same content as a.txt
    const snap2: Snapshot = await fileService.createSnapshot(TMP_DIR);

    const flat2: Flat = await fileService.reconstructSnapshot(snap2.id);
    expect(flat2["a.txt"]).toBe(flat2["b.txt"]); // same hash

    // Unique cost of snap2 should be 0, since no new blob introduced
    const physicalSize = await fileService.physicalSize(snap2.id);
    expect(physicalSize).toBe(0);
  });
});