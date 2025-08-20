# TypeScript CLI Backup Tool

 ⚠️ Note: This implementation is optimized only for clarity and simplicity, not scalability. It is best suited for demos, small workloads, or experimentation. 
 (To scale we'd need to introduce a db for the snapshots, and an external filesystem such as S3 or similar)

 It is also not optimized for performance.
 - There are some redundant file reads
 - Directory traversal is not optimized
 - Synchronous I/O is used
 - Inefficient snapshot / memory usage

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

 Example:

    $ node dist/index.js snapshot ~/my_important_files

### `list`

Lists snapshots that are stored in the database.

 Example:

    $ node dist/index.js list
    Snapshots:
    ID: 1, TIMESTAMP: 2025-08-20T01:39:44.176Z, SIZE: 298 KB, DISTINCT: 298 KB
    Total size: 298 KB

### `restore`

Restores the directory state from any previous snapshot into a new directory.

 Example:

    $ node dist/index.js restore 42 ./out

### `prune`

Removes old snapshots from the database and deletes any unreferenced data.

 Example:

    $ node dist/index.js prune 42


### License
This project is licensed under the MIT License. See the LICENSE file for more details.