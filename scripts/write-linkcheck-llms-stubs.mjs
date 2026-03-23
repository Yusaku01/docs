import { mkdir, writeFile } from 'node:fs/promises';

const distDir = new URL('../dist/', import.meta.url);
const llmsFiles = [
	['llms.txt', '# Linkcheck-only stub\n'],
	['llms-full.txt', '# Linkcheck-only stub\n'],
	['llms-small.txt', '# Linkcheck-only stub\n'],
];

await mkdir(distDir, { recursive: true });

await Promise.all(
	llmsFiles.map(([name, contents]) => writeFile(new URL(name, distDir), contents, 'utf8'))
);
