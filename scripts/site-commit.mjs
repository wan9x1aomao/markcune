// Replaces a set of site files together. A failure puts back anything already replaced.
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function commitFiles(operations) {
  const staged = [];
  try {
    for (const op of operations) {
      mkdirSync(dirname(op.dest), { recursive: true });
      const tmp = `${op.dest}.mdpad-new`;
      if (op.html != null) writeFileSync(tmp, op.html);
      else copyFileSync(op.source, tmp);
      staged.push({ dest: op.dest, tmp });
    }
    const replaced = [];
    try {
      for (const item of staged) {
        const bak = `${item.dest}.mdpad-bak`;
        const had = existsSync(item.dest);
        if (had && statSync(item.dest).isDirectory()) {
          throw new Error(`${item.dest} 是目录，不能替换`);
        }
        if (had) renameSync(item.dest, bak);
        try {
          renameSync(item.tmp, item.dest);
        } catch (error) {
          if (had && existsSync(bak)) renameSync(bak, item.dest);
          throw error;
        }
        replaced.push({ dest: item.dest, bak: had ? bak : null });
      }
    } catch (error) {
      for (const item of replaced.reverse()) {
        if (existsSync(item.dest)) unlinkSync(item.dest);
        if (item.bak && existsSync(item.bak)) renameSync(item.bak, item.dest);
      }
      throw error;
    }
    for (const item of replaced) {
      if (item.bak && existsSync(item.bak)) unlinkSync(item.bak);
    }
  } finally {
    for (const item of staged) {
      if (existsSync(item.tmp)) unlinkSync(item.tmp);
    }
  }
}
