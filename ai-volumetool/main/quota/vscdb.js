// 只读提取 VS Code 系 state.vscdb（SQLite）ItemTable 里的指定 key
// 纯 Node 实现，不引原生依赖：走「自动索引二分查 key → 表树二分查 rowid」，
// 即使库有 10GB 也只按页读几个 4KB 块。Cursor 的 accessToken 就存在这里。
const fs = require('fs');

// SQLite 变长整数：1~9 字节大端，前 8 字节每字节贡献低 7 位
function readVarint(buf, off) {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    const b = buf[off + i];
    v = (v << 7n) | BigInt(b & 0x7f);
    if (!(b & 0x80)) return [v, off + i + 1];
  }
  return [(v << 8n) | BigInt(buf[off + 8]), off + 9];
}

// 记录（行）解析：变长头里是各列的序列类型，随后是数据
function parseRecord(payload) {
  const [hLenVar, hdrEnd] = readVarint(payload, 0);
  const hLen = Number(hLenVar);
  const types = [];
  let o = hdrEnd;
  while (o < hLen) {
    const [t, no] = readVarint(payload, o);
    types.push(Number(t));
    o = no;
  }
  const cols = [];
  let d = hLen;
  for (const n of types) {
    if (n === 0) cols.push(null);
    else if (n >= 1 && n <= 6) { const size = [1, 2, 3, 4, 6, 8][n - 1]; cols.push(payload.readUIntBE(d, size)); d += size; }
    else if (n === 7) { cols.push(payload.slice(d, d + 8)); d += 8; }
    else if (n === 8) cols.push(0);
    else if (n === 9) cols.push(1);
    else if (n >= 12 && n % 2 === 0) { const len = (n - 12) / 2; cols.push(payload.slice(d, d + len)); d += len; }
    else { const len = (n - 13) / 2; cols.push(payload.slice(d, d + len).toString('utf8')); d += len; }
  }
  return cols;
}

function readKeyFromVscdb(dbPath, wantedKey) {
  const fd = fs.openSync(dbPath, 'r');
  try {
    const head = Buffer.alloc(100);
    fs.readSync(fd, head, 0, 100, 0);
    if (head.slice(0, 15).toString() !== 'SQLite format 3') throw new Error('不是 SQLite 文件');
    let pageSize = head.readUInt16BE(16);
    if (pageSize === 1) pageSize = 65536;
    const usable = pageSize - head[20];
    const readPage = (n) => {
      const b = Buffer.alloc(pageSize);
      fs.readSync(fd, b, 0, pageSize, (n - 1) * pageSize);
      return b;
    };
    const cellCount = (p) => p.readUInt16BE(3);
    // 内部页（0x02 索引 / 0x05 表）页头 12 字节（多 4 字节最右子指针），叶子页 8 字节
    const cellPtr = (p, type, i) => p.readUInt16BE((type === 0x02 || type === 0x05 ? 12 : 8) + 2 * i);
    const tableMaxLocal = usable - 35;
    const indexMaxLocal = Math.floor(((usable - 12) * 64) / 255) - 23;

    // —— 第一步：遍历 sqlite_master（第 1 页起的小树），拿 ItemTable 的表根页与自动索引根页 ——
    // 第 1 页开头有 100 字节文件头，b-tree 页头在偏移 100；但 cell 指针值相对页首（0 起），不能切片
    let tableRoot = null, indexRoot = null;
    (function walkMaster(pageNo) {
      const p = readPage(pageNo);
      const h = pageNo === 1 ? 100 : 0;
      const type = p[h];
      const n = p.readUInt16BE(h + 3);
      if (type === 0x0D) {
        for (let i = 0; i < n; i++) {
          const c = p.readUInt16BE(h + 8 + 2 * i);
          const [plVar, o1] = readVarint(p, c);
          const [, o2] = readVarint(p, o1); // 跳过 rowid
          const pl = Number(plVar);
          if (pl > tableMaxLocal) continue; // schema 行不会溢出，防御一下
          const cols = parseRecord(p.slice(o2, o2 + pl));
          const [rowType, name, tblName, rootPage] = cols;
          if (tblName === 'ItemTable') {
            if (rowType === 'table' && name === 'ItemTable') tableRoot = Number(rootPage);
            else if (rowType === 'index') indexRoot = Number(rootPage); // sqlite_autoindex_ItemTable_1
          }
        }
      } else if (type === 0x05) {
        for (let i = 0; i < n; i++) walkMaster(p.readUInt32BE(p.readUInt16BE(h + 12 + 2 * i)));
        walkMaster(p.readUInt32BE(h + 8));
      }
    })(1);
    if (!tableRoot) return null;

    // —— 第二步：有索引就在索引树里二分 key → rowid；没有则只能全表扫（正常不会发生） ——
    let rowid = null;
    if (indexRoot) {
      const keyBuf = Buffer.from(wantedKey, 'utf8');
      (function searchIndex(pageNo) {
        if (rowid !== null) return;
        const p = readPage(pageNo);
        const type = p[0];
        const n = cellCount(p);
        if (type === 0x0A || type === 0x02) {
          for (let i = 0; i < n && rowid === null; i++) {
            const c = cellPtr(p, type, i);
            let child = null, o = c;
            if (type === 0x02) { child = p.readUInt32BE(c); o = c + 4; }
            const [plVar, o1] = readVarint(p, o);
            const pl = Number(plVar);
            if (pl <= indexMaxLocal) {
              const cols = parseRecord(p.slice(o1, o1 + pl));
              const k = cols[0];
              const cmp = typeof k === 'string' ? Buffer.compare(Buffer.from(k, 'utf8'), keyBuf) : -1;
              if (cmp === 0) { rowid = Number(cols[1]); return; }
              if (type === 0x02 && cmp > 0) { searchIndex(child); return; } // key 在左子树
            }
          }
          if (type === 0x02) searchIndex(p.readUInt32BE(8)); // 都比 key 小 → 最右子树
        }
      })(indexRoot);
    }
    if (rowid === null) {
      // 兜底：无索引时线性扫表叶子（key 顺序无序，只能全扫）
      (function scan(pageNo) {
        if (rowid !== null) return;
        const p = readPage(pageNo);
        const type = p[0];
        const n = cellCount(p);
        if (type === 0x0D) {
          for (let i = 0; i < n && rowid === null; i++) {
            const c = cellPtr(p, type, i);
            const [plVar, o1] = readVarint(p, c);
            const [ridVar, o2] = readVarint(p, o1);
            const pl = Number(plVar);
            if (pl > tableMaxLocal) continue;
            const cols = parseRecord(p.slice(o2, o2 + pl));
            if (cols[0] === wantedKey) rowid = Number(ridVar);
          }
        } else if (type === 0x05) {
          for (let i = 0; i < n; i++) scan(p.readUInt32BE(cellPtr(p, type, i)));
          scan(p.readUInt32BE(8));
        }
      })(tableRoot);
      if (rowid === null) return null;
    }

    // —— 第三步：表树按 rowid 二分 → 记录 → value 列 ——
    let p = readPage(tableRoot);
    for (;;) {
      const type = p[0];
      const n = cellCount(p);
      if (type === 0x05) {
        let next = p.readUInt32BE(8);
        for (let i = 0; i < n; i++) {
          const c = cellPtr(p, type, i);
          const child = p.readUInt32BE(c);
          const [kVar] = readVarint(p, c + 4);
          if (BigInt(rowid) < kVar) { next = child; break; }
        }
        p = readPage(next);
      } else if (type === 0x0D) {
        for (let i = 0; i < n; i++) {
          const c = cellPtr(p, type, i);
          const [plVar, o1] = readVarint(p, c);
          const [ridVar, o2] = readVarint(p, o1);
          if (Number(ridVar) === rowid) {
            const pl = Number(plVar);
            if (pl > tableMaxLocal) return null; // 超长值走溢出页，正常 key/value 用不到
            const cols = parseRecord(p.slice(o2, o2 + pl));
            const v = cols[1];
            return typeof v === 'string' ? v : v == null ? null : v.toString('utf8');
          }
        }
        return null;
      } else return null;
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readKeyFromVscdb };
