import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getPagePathnamesFromSitemap } from '../../scripts/lib/linkcheck/steps/build-index.ts';
import {
	findLinkIssues,
	addSourceFileAnnotations,
} from '../../scripts/lib/linkcheck/steps/find-issues.ts';
import { LinkCheckerState } from '../../scripts/lib/linkcheck/base/base.ts';
import { TargetExists } from '../../scripts/lib/linkcheck/checks/target-exists.ts';
import { SameLanguage } from '../../scripts/lib/linkcheck/checks/same-language.ts';
import { CanonicalUrl } from '../../scripts/lib/linkcheck/checks/canonical-url.ts';
import { RelativeUrl } from '../../scripts/lib/linkcheck/checks/relative-url.ts';
import { GoodLabels } from '../../scripts/lib/linkcheck/checks/good-link-label.ts';

const variant = process.argv[2];
if (variant) {
	const source =
		variant === 'baseline' ? process.env.LINKCHECK_BASELINE : 'scripts/lib/linkcheck/base/page.ts';
	const { HtmlPage } = await import(pathToFileURL(path.resolve(source)));
	const options = {
		baseUrl: 'https://docs.astro.build',
		buildOutputDir: 'dist',
		pageSourceDir: 'src/content/docs',
		checks: [
			new TargetExists(),
			new SameLanguage({ ignoredLinkPathnames: ['/lighthouse/'] }),
			new CanonicalUrl({ ignoreMissingCanonicalUrl: ['/lighthouse/'] }),
			new RelativeUrl(),
			new GoodLabels(),
		],
		autofix: false,
	};
	const paths = getPagePathnamesFromSitemap(options);
	assert(paths.length > 0, 'The benchmark must not pass with zero pages');
	const pages = {};
	let readMs = 0,
		parseMs = 0;
	for (const pathname of paths) {
		let t = performance.now();
		const html = fs.readFileSync(path.join('dist', pathname, 'index.html'), 'utf8');
		readMs += performance.now() - t;
		t = performance.now();
		const page = new HtmlPage({ html, href: new URL(pathname, options.baseUrl).href, pathname });
		pages[pathname] = page;
		parseMs += performance.now() - t;
		assert(page.isRedirect || page.hasContent, `Missing content: ${pathname}`);
		assert(page.isRedirect || page.mainContentLang, `Missing language: ${pathname}`);
	}
	let t = performance.now();
	const issues = findLinkIssues(pages, options, new LinkCheckerState());
	const checkMs = performance.now() - t;
	t = performance.now();
	addSourceFileAnnotations(issues, options);
	const annotationMs = performance.now() - t;
	const peakRssMiB = process.resourceUsage().maxRSS / 1024;
	global.gc();
	const retainedHeapMiB = process.memoryUsage().heapUsed / 1024 ** 2;
	// Fingerprints are computed outside the measured phases, including every stored
	// field, language-dependent path, issue, fix suggestion, and source annotation.
	const pageHash = createHash('sha256');
	for (const page of Object.values(pages))
		pageHash.update(
			JSON.stringify({
				page,
				expected: [null, 'en', 'ja', 'fr'].map((lang) => page.getExpectedLinkPathname(lang)),
			})
		);
	const issueHash = createHash('sha256')
		.update(
			JSON.stringify(
				issues.map((i) => ({
					page: i.page.pathname,
					href: i.linkHref,
					type: i.type.formatTitle(),
					check: i.check.constructor.name,
					autofix: i.autofixHref,
					annotation: i.annotationText,
					source: i.sourceFileAnnotations,
				}))
			)
		)
		.digest('hex');
	console.log(
		JSON.stringify({
			variant,
			pages: paths.length,
			readSeconds: readMs / 1000,
			parseSeconds: parseMs / 1000,
			checkSeconds: checkMs / 1000,
			annotationSeconds: annotationMs / 1000,
			totalSeconds: (readMs + parseMs + checkMs + annotationMs) / 1000,
			peakRssMiB,
			retainedHeapMiB,
			pageHash: pageHash.digest('hex'),
			issueHash,
			issues: issues.length,
		})
	);
} else {
	const runs = [];
	// Fresh processes; reverse the pair order to reduce order-related cache bias.
	for (const variant of [
		'baseline',
		'candidate',
		'candidate',
		'baseline',
		'baseline',
		'candidate',
	]) {
		const child = spawnSync(
			process.execPath,
			['--expose-gc', '--experimental-transform-types', import.meta.filename, variant],
			{ encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
		);
		if (child.status !== 0) {
			process.stderr.write(child.stderr);
			throw new Error(`Benchmark ${variant} failed: ${child.stdout}`);
		}
		const result = JSON.parse(child.stdout);
		runs.push(result);
		console.log(JSON.stringify(result));
	}
	const metadata = {
		baseSha: process.env.BASE_SHA,
		headSha: process.env.GITHUB_SHA,
		node: process.version,
		platform: process.platform,
		architecture: process.arch,
		order: runs.map((r) => r.variant),
	};
	fs.writeFileSync(
		path.join(import.meta.dirname, 'results.json'),
		JSON.stringify({ metadata, runs }, null, 2)
	);
	for (const run of runs) {
		assert.equal(run.pages, runs[0].pages);
		assert.equal(run.pageHash, runs[0].pageHash, 'Page extraction differs');
		assert.equal(run.issueHash, runs[0].issueHash, 'Issues or annotations differ');
	}
	const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
	let summary =
		'## Linkcheck comparison\n\nOne shared build, fresh process per sample, three samples per variant. Build time is excluded.\n\n| Median | Baseline | Candidate |\n| --- | ---: | ---: |\n';
	for (const key of [
		'readSeconds',
		'parseSeconds',
		'checkSeconds',
		'totalSeconds',
		'peakRssMiB',
		'retainedHeapMiB',
	])
		summary += `| ${key} | ${median(runs.filter((r) => r.variant === 'baseline').map((r) => r[key])).toFixed(3)} | ${median(runs.filter((r) => r.variant === 'candidate').map((r) => r[key])).toFixed(3)} |\n`;
	summary += `\nAll ${runs[0].pages} pages and ${runs[0].issues} issues (including fix suggestions and source annotations) match in all runs.\n`;
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
	assert.equal(runs[0].issues, 0, 'Shared build has link issues; inspect normal CI annotations');
}
