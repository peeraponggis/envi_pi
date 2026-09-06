// ตรวจว่า <script type="module"> ในทุกหน้า web/*.html แยกวิเคราะห์ได้ (กันเคส "Identifier has already been declared" ที่ทำให้ทั้งหน้าไม่รัน 6 ก.ย. 69)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const dir = new URL('../web/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
for (const f of readdirSync(dir).filter((n) => n.endsWith('.html'))) {
  const src = readFileSync(join(dir, f), 'utf8');
  const mods = [...src.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  for (const [i, m] of mods.entries()) {
    test(`${f} module #${i + 1} parses`, () => {
      const tmp = join(dir, `.${f}.${i}.check.mjs`);
      writeFileSync(tmp, m[1]);
      try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
      catch (e) { assert.fail(String(e.stderr).split('\n').slice(0, 6).join('\n')); }
      finally { unlinkSync(tmp); }
    });
  }
}
