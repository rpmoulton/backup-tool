# TypeScript CLI Backup Tool

### Prerequisites

- Node.js (version 12 or higher)
- npm (Node package manager)

## Usage
 - `npm i`
 - `npm run build`
 - `node dist/index.js <command> <arguments>`
 - `npm test`

 - Create a sample directory to test with using a 1 liner like:
 ```
 mkdir -p testdir && echo "alpha" > testdir/file1.txt && echo "beta" > testdir/file2.txt && echo "gamma" > testdir/file3.txt
 ```
 - take a snapshot 
 ```
 node dist/index.js snapshot testdir
 ```

 - Make changes to file content
 ```
 echo "BLAH BLAH BLAH" >> testdir/file2.txt
 ```
 - Take a new snapshot:
 ```
 node dist/index.js snapshot testdir
 ```

- List the snapshots:
```
node dist/index.js list
```

- Repeat as desired

- Remove a snapshot:
```
node dist/index.js prune 2
```

- Restore a snapshot:
``` 
node dist/index.js restore 3
```


## Operations

### `snapshot`

Takes a snapshot of all files in the specified directory and stores their
content and filenames in a "database". (the filesystem .mydb)

- Only the file contents and filenames are stored as part of the snapshot;
  metadata like permissions, ownership, or timestamps are ignored.
- Snapshots store only incremental differences in order to minimize the
  size of the database. That is, the minimal amount of data necessary to
  express the new state of the directory by referencing already-stored data.
- The tool does not store any duplicate file or directory content. It uses
  content hashes (such as SHA-256) to detect changes and avoid storing
  duplicate content.
- The database is the filesystem -- it utilizes a .mydb folder to store blobs and snapshots
- Snapshots are given a number in sequence based on the order in which they
  were created.

Illustrative example:

    $ node dist/index.js snapshot ~/my_important_files

### `list`

Lists snapshots that are stored in the database.

- Snapshots are listed in a table on console.log with the following columns:
  snapshot number, timestamp, size (logical), distinct (physical)

Illustrative example:

    $ node dist/index.js list
    Snapshots:
    ID: 1, TIMESTAMP: 2025-08-20T01:39:44.176Z, SIZE: 298 KB, DISTINCT: 298 KB
    Total size: 298 KB

### `restore`

Restores the directory state from any previous snapshot into a new directory.

- The recreates the entire directory structure and contents exactly
  as they were at the time of the snapshot.
- Only the files present in the snapshot are restored.
- All files that were originally shapshotted are restored.
- The restored files are bit-for-bit identical to the originally
  snapshotted files.

Illustrative example:

    $ node dist/index.js restore 42 ./out

### `prune`

Removes old snapshots from the database and deletes any unreferenced data.

- The tool allows the user to prune older snapshots while ensuring no
  data loss from the remaining snapshots.
- After pruning, all remaining snapshots are still fully restorable.

Illustrative example:

    $ node dist/index.js prune 42


### License
This project is licensed under the MIT License. See the LICENSE file for more details.