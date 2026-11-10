import assert from 'node:assert/strict';
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
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { HtmlPage as Candidate } from '../../scripts/lib/linkcheck/base/page.ts';
const { HtmlPage: Baseline } = await import(pathToFileURL(resolve(process.env.LINKCHECK_BASELINE)));

{
	const fixtures = {
		empty: '',
		body: '<html lang="ja"><body><a href="/ja/">Home</a></body></html>',
		mainPriority:
			'<html lang="en"><body lang="ja"><main lang="fr"></main><main lang="de"></main></body></html>',
		noLang: '<body><main lang=""></main></body>',
		inheritedEmpty: '<body lang="ja"><div lang=""><main></main></div></body>',
		outsideBody: '<body lang="en"></body><main lang="ja"></main>',
		anchors:
			'<main lang="en"><a id="id" name="old" href="/en/#id">Click <b>here</b><br> now &amp; then</a><a name="" href=""></a><a>Missing</a></main>',
		namesAndIds:
			'<body><i id="first"></i><a id="second" name="third"></a><p id=""></p><a name="third" href="#first"></a></body>',
		nested: '<body><a href="/a">outer<a href="/b">inner</a>end</a></body>',
		scriptStyle:
			'<body><a href="/a">a<script id="s">ignored</script>b<style id="t">ignored</style>c<!--ignored--></a></body>',
		template:
			'<body><a href="/a"><template>template</template><svg><title>svg</title></svg></a></body>',
		implied: '<body lang="ja"><p><a href="/a">a<p id="b">b<ul><li>c<li>d</ul>',
		case: '<HTML LANG="ja"><BODY><MAIN><A HREF="/ja/" ID="x">日本語</A></MAIN></BODY></HTML>',
		entities:
			'<body><a name="&amp;" href="/a?b=1&amp;c=2">&#x1f680; &nbsp; &copy; &#65;</a></body>',
		percent: '<body><a href="/ja/%E6%97%A5%E6%9C%AC/#%E8%AA%9E">語</a></body>',
		invalidPercent: '<body><a href="%GG">bad</a></body>',
		canonical:
			'<link rel="CANONICAL" href="https://docs.astro.build/en/a/"><link rel="canonical" href="https://other.test"><body>',
		badCanonical: '<link rel="canonical" href="relative"><body>',
		missingCanonical: '<link rel="canonical"><body>',
		redirect: '<meta http-equiv="REFRESH" content="0; url = /en/new/"><body>',
		firstInvalidRefresh:
			'<meta http-equiv="refresh" content="bad"><meta http-equiv="refresh" content="0;url=/valid/"><body>',
		malformed: '<body lang="en"><div lang="ja"><main><a href="/x">one</div>two</a></main>',
		cdata: '<body><a href="/x"><![CDATA[ignored]]><svg><![CDATA[svg text]]></svg></a></body>',
		duplicateAttrs: '<body><a href="/a" href="/b" id="x" id="y">test</a></body>',
		firstEmptyMain: '<body lang=""><main></main><main lang="ja"></main></body>',
	};
	function read(Type, html, pathname = '/ja/test/') {
		try {
			const p = new Type({ html, href: 'https://docs.astro.build' + pathname, pathname });
			return {
				data: JSON.parse(JSON.stringify(p)),
				expected: [null, 'en', 'ja', 'fr'].map((l) => p.getExpectedLinkPathname(l)),
			};
		} catch (e) {
			return { error: e.name, message: e.message };
		}
	}
	for (const [name, html] of Object.entries(fixtures))
		assert.deepEqual(read(Candidate, html), read(Baseline, html), name);
	for (const path of ['/', '/en/test/', '/zh-cn/test/', '/ja/test/', '/not-language/test/'])
		assert.deepEqual(
			read(Candidate, fixtures.body, path),
			read(Baseline, fixtures.body, path),
			path
		);
	console.log(
		JSON.stringify({ fixtureCases: Object.keys(fixtures).length + 5, result: 'exact match' })
	);
}
{
	let seed = 20261101;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	const tokens = [
		'<html lang="en">',
		'<body lang="ja">',
		'<main>',
		'<main lang="fr">',
		'<main lang="">',
		'<div lang="de">',
		'</div>',
		'</main>',
		'</body>',
		'<a href="/ja/#x">',
		'<a name="old" id="x">',
		'</a>',
		'<a href="/en/?x=1&amp;y=2">',
		'<a href="%GG">',
		'<a href="">',
		'日本語',
		'&amp; &#x1F680;',
		'<b>bold</b>',
		'<br>',
		'<!-- comment -->',
		'<script>ignore<a id="fake">x</a></script>',
		'<style>a{color:red}</style>',
		'<template>inside</template>',
		'<p>',
		'</p>',
		'<li id="y">',
		'</li>',
		'<link rel="canonical" href="https://docs.astro.build/en/a/">',
		'<link rel="canonical" href="bad">',
		'<meta http-equiv="refresh" content="0;url=/en/">',
		'<meta http-equiv="refresh" content="invalid">',
		'<svg><a href="/en/">svg</a></svg>',
		'<textarea>not a link <a href="/x"></textarea>',
	];
	const result = (Type, html) => {
		try {
			return {
				page: JSON.parse(
					JSON.stringify(
						new Type({ html, href: 'https://docs.astro.build/ja/test/', pathname: '/ja/test/' })
					)
				),
			};
		} catch (e) {
			return { error: e.name, message: e.message };
		}
	};
	for (let i = 0; i < 1500; i++) {
		let html = '';
		for (let j = 0; j < 25; j++) html += tokens[random() % tokens.length];
		try {
			assert.deepEqual(result(Candidate, html), result(Baseline, html));
		} catch (e) {
			console.error(html);
			throw e;
		}
	}
	console.log(JSON.stringify({ seed: 20261101, cases: 1500, result: 'exact match' }));
}
{
	const base = 'https://docs.astro.build';
	const html = {
		'/en/a/':
			'<link rel="canonical" href="https://docs.astro.build/en/a/"><body lang="en"><main><h1 id="ok">a</h1><a href="/missing/">broken page</a><a href="/en/b/#missing">broken fragment</a><a href="/en/redir/">redirect</a><a href="/en/nocan/">canonical missing</a><a href="/en/alias/">alias</a><a href="https://docs.astro.build/en/b/">absolute</a><a href="/ja/b/">wrong language</a><a href="/en/b/">Click here</a><a href="/en/b/#ok">valid</a></main></body>',
		'/en/b/':
			'<link rel="canonical" href="https://docs.astro.build/en/b/"><body lang="en"><h1 id="ok">b</h1></body>',
		'/ja/b/':
			'<link rel="canonical" href="https://docs.astro.build/ja/b/"><body lang="ja"><h1 id="ok">b</h1></body>',
		'/en/redir/': '<meta http-equiv="refresh" content="0;url=/en/b/">',
		'/en/nocan/': '<body lang="en">no canonical</body>',
		'/en/alias/':
			'<link rel="canonical" href="https://docs.astro.build/en/b/"><body lang="en">alias</body>',
		'/ja/fallback/':
			'<link rel="canonical" href="https://docs.astro.build/en/b/"><body lang="en"><a href="/en/b/">here</a></body>',
	};
	function run(Type) {
		const pages = Object.fromEntries(
			Object.entries(html).map(([pathname, html]) => [
				pathname,
				new Type({ html, href: base + pathname, pathname }),
			])
		);
		const options = {
			baseUrl: base,
			buildOutputDir: 'dist',
			checks: [
				new TargetExists(),
				new SameLanguage(),
				new CanonicalUrl(),
				new RelativeUrl(),
				new GoodLabels(),
			],
		};
		return findLinkIssues(pages, options, new LinkCheckerState()).map((i) => ({
			page: i.page.pathname,
			href: i.linkHref,
			type: i.type.formatTitle(),
			autofix: i.autofixHref,
			annotation: i.annotationText,
		}));
	}
	const old = run(Baseline),
		updated = run(Candidate);
	assert.deepEqual(updated, old);
	assert(old.length >= 7);
	console.log(
		JSON.stringify({
			pages: Object.keys(html).length,
			issues: old.length,
			types: [...new Set(old.map((i) => i.type))],
			result: 'exact match including autofix suggestions',
		})
	);
}
