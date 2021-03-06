/// <reference path="untyped.d.ts" />

import { execFileSync } from "child_process";
import * as fs from "fs";
import fetch from "node-fetch";
import {
	Attr,
	Cite,
	FilterActionAsync,
	filter,
	Format,
	Link,
	metaMapToRaw,
	PandocJson,
	rawToMeta,
	Space,
	Superscript,
	PandocMetaValue,
} from "pandoc-filter";
import { isURL } from "./util";

/**
 * config options loaded from markdown frontmatter
 *
 * can also be specified as a command line option, e.g. `pandoc -V url2cite=all-links`
 **/
export type Configuration = {
	/**
	 * if all-links then convert all links to citations. otherwise only parse pandoc citation syntax
	 */
	url2cite?: "all-links" | "citation-only";
	/**
	 * only relevant for links converted to citations (if urlcite=all-links)
	 *
	 * - cite-only: [text](href) becomes [@href]
	 * - sup: [text](href) becomes [text](href)^[@href]
	 * - normal: [text](href) becomes [text [@href]](href)
	 *
	 *  default: sup if html else normal
	 */
	"url2cite-link-output"?: "cite-only" | "sup" | "normal";
	/**
	 * location of the cache file
	 * default: ./citation-cache.json (relative to invocation directory of pandoc)
	 */
	"url2cite-cache"?: string;
	/**
	 * Whether to allow citations without an accompanying url. Useful for manual citations that aren't
	 * automatically found by url2cite and are managed manually or with a different tool
	 */
	"url2cite-allow-dangling-citations"?: boolean;
};

/** type of the citation-cache.json file */
type Cache = {
	_info: string;
	urls: { [url: string]: { fetched: string; bibtex: string[]; csl: any } };
};

async function bibtex2csl(bibtex: string) {
	const res = execFileSync(
		"pandoc-citeproc",
		["--bib2json", "--format=biblatex"],
		{
			input: bibtex,
			encoding: "utf8",
		},
	);
	return JSON.parse(res);
}

async function getCslForUrl(url: string) {
	// uses zotero extractors from https://github.com/zotero/translators to get information from URLs
	// https://www.mediawiki.org/wiki/Citoid/API
	// It should be possible to run a citoid or [zotero translation-server](https://github.com/zotero/translation-server) locally,
	// but this works fine for now and is much simpler than trying to run that server in e.g. docker automatically.
	// A server is needed since Zotero extractors run within the JS context of the website.
	// It might be possible to fake the context and just run most extractors in Node, but that would be much more fragile and need a lot of testing.
	// It should also be possible to use something like puppeteer to fetch the website headlessly and then run the extractor.

	console.warn("fetching citation from url", url);
	const res = await fetch(
		`https://en.wikipedia.org/api/rest_v1/data/citation/bibtex/${encodeURIComponent(
			url,
		)}`,
	);

	if (!res.ok) {
		throw Error(
			`could not fetch citation from ${url}: ${await res.text()}`,
		);
	}
	const bibtex = await res.text();
	const [csl] = await bibtex2csl(bibtex);
	for (const k of Object.keys(csl)) {
		// unescape since pandoc-citeproc outputs markdown-escaped text
		// this regex is not 100% correct, e.g. "\\\[test]"
		if (typeof csl[k] === "string")
			csl[k] = csl[k].replace(/\\(?!\\)/g, "");
	}
	csl.id = url;

	return {
		fetched: new Date().toJSON(),
		bibtex: bibtex.replace(/\t/g, "   ").split("\n"), // split to make json file more readable
		csl,
	};
}

export class Url2Cite {
	/** written to CWD from which pandoc is called */
	citationCachePath = "citation-cache.json";
	cache: Cache = {
		_info:
			"Auto-generated by pandoc-url2cite. Feel free to modify, keys will never be overwritten.",
		urls: {},
	};

	citekeys: { [key: string]: string } = {};

	async getCslForUrlCached(url: string) {
		if (url in this.cache.urls) return;
		this.cache.urls[url] = await getCslForUrl(url);
		// Write cache after every successful fetch. Somewhat inefficient.
		this.writeCache();
	}

	// Only needed for link syntax (not pandoc cite syntax)
	//
	// Since pandoc (with citations extension) does not parse `[@name]: http://...` as
	// [link reference definitions](https://spec.commonmark.org/0.29/#link-reference-definition)
	// we convert them ourselves. This leads to small inconsistencies in what you can do vs. in normal reference definitions:
	// 1. They need to be in their own paragraph.
	// 2. link title is not parsed (but also would not be used anyways)
	extractCiteKeys: FilterActionAsync = async (el, _outputFormat, _meta) => {
		if (el.t === "Para") {
			while (
				el.c.length >= 3 &&
				el.c[0].t === "Cite" &&
				el.c[0].c[0].length === 1 &&
				el.c[1].t === "Str" &&
				el.c[1].c === ":"
			) {
				const sp = el.c[2].t === "Space" ? 3 : 2;
				const v = el.c[sp];
				if (v.t === "Str") {
					// paragraph starts with [@something]: something
					// save info to citekeys and remove from paragraph
					const key = el.c[0].c[0][0].citationId;
					const url = v.c;
					if (key in this.citekeys)
						console.warn("warning: duplicate citekey", key);
					this.citekeys[key] = url;
					// found citation, add it to citekeys and remove it from document
					el.c = el.c.slice(sp + 1);
					if (el.c.length > 0 && el.c[0].t === "SoftBreak")
						el.c.shift();
				}
			}
			return el;
		}
	};
	/**
	 * transform the pandoc document AST
	 * - replaces links with citations if `all-links` is active or they are marked with `url2cite` class/title
	 * - replaces citekeys with urls, fetches missing citations and writes them to cache
	 */
	astTransformer: FilterActionAsync = async (el, outputF, m) => {
		const meta = metaMapToRaw(m) as Configuration;
		if (el.t === "Cite") {
			const [citations, _inline] = el.c;
			for (const citation of citations) {
				const id = citation.citationId;
				const url = isURL(id) ? id : this.citekeys[id];
				if (!url) {
					if (meta["url2cite-allow-dangling-citations"]) continue;
					else throw Error(`Could not find URL for @${id}.`);
				}
				if (typeof url !== "string")
					throw Error(`url for ${id} is not string: ${url}`);
				await this.getCslForUrlCached(url);
				// replace the citation id with the url
				citation.citationId = url;
			}
		} else if (el.t === "Link") {
			const [[id, classes, kv], inline, [url, targetTitle]] = el.c;

			if (
				meta.url2cite === "all-links" ||
				classes.includes("url2cite") ||
				/\burl2cite\b/.test(targetTitle)
			) {
				if (
					classes.includes("no-url2cite") ||
					/\bno-url2cite\b/.test(targetTitle)
				) {
					// disabling per link overrides enabling
					return;
				}
				if (!isURL(url)) {
					// probably a relative URL. Keep it as is
					return;
				}
				await this.getCslForUrlCached(url);

				// here we basically convert a link of form [text](href)
				// to one of form [text [@{href}]](href)
				const cite = Cite(
					[
						{
							citationSuffix: [],
							citationNoteNum: 0,
							citationMode: {
								t: "NormalCitation",
							} as any, // wrong typings
							citationPrefix: [],
							citationId: url,
							citationHash: 0,
						},
					],
					[],
				);
				const defFormat = outputF === "html" ? "sup" : "normal";
				const outputFormat = meta["url2cite-link-output"] || defFormat;
				if (outputFormat === "cite-only") return cite;
				const attr: Attr = [
					id,
					classes,
					[
						...kv,
						["cite-meta", JSON.stringify(this.cache.urls[url].csl)],
					],
				];
				if (outputFormat === "sup")
					return [
						Link(attr, [...inline], [url, targetTitle]),
						Superscript([cite]),
					];
				else if (outputFormat === "normal") {
					return Link(
						attr,
						[...inline, Space(), cite],
						[url, targetTitle],
					);
				}
				throw Error(`Unknown output format ${outputFormat}`);
			}
		}
	};

	async transform(data: PandocJson, format: Format) {
		try {
			const m = metaMapToRaw(data.meta) as Configuration;
			if (m["url2cite-cache"])
				this.citationCachePath = String(m["url2cite-cache"]);
			this.cache = JSON.parse(
				fs.readFileSync(this.citationCachePath, "utf8"),
			);
		} catch {}

		// untyped https://github.com/mvhenderson/pandoc-filter-node/issues/9
		data = await filter(data, this.extractCiteKeys, format);
		data = await filter(data, this.astTransformer, format);
		console.warn(
			`got all ${
				Object.keys(this.cache.urls).length
			} citations from URLs`,
		);
		// add all cached references to the frontmatter. pandoc-citeproc will handle
		// (ignore) unused keys. Concatenate with existing references if any exist.
		const existingRefs =
			data.meta.references !== undefined &&
			data.meta.references.t === "MetaList"
				? data.meta.references.c
				: [];
		const refs = rawToMeta(
			Object.entries(this.cache.urls).map(([url, { csl }]) => csl),
		) as { t: "MetaList"; c: PandocMetaValue[] };

		data.meta.references = {
			t: "MetaList",
			c: refs.c.concat(existingRefs),
		};

		return data;
	}
	writeCache() {
		fs.writeFileSync(
			this.citationCachePath,
			JSON.stringify(this.cache, null, "\t"),
		);
	}
}
