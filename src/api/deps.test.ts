import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDependencies } from "./deps.js";

describe("parseDependencies", () => {
	it("parses bold 'Depends on:' with single ref", () => {
		assert.deepStrictEqual(parseDependencies("**Depends on:** #43"), [43]);
	});

	it("parses italic variant", () => {
		assert.deepStrictEqual(parseDependencies("*Depends on:* #43"), [43]);
	});

	it("parses comma-separated refs", () => {
		assert.deepStrictEqual(parseDependencies("Depends on: #43, #44"), [43, 44]);
	});

	it("parses without colon", () => {
		assert.deepStrictEqual(parseDependencies("Depends on #43"), [43]);
	});

	it("parses 'and' separator", () => {
		assert.deepStrictEqual(parseDependencies("Depends on: #43 and #44"), [43, 44]);
	});

	it("parses bold 'Parent:' format (oh-task)", () => {
		assert.deepStrictEqual(parseDependencies("**Parent:** #1179"), [1179]);
	});

	it("parses plain 'Parent:' format", () => {
		assert.deepStrictEqual(parseDependencies("Parent: #1178"), [1178]);
	});

	it("parses Parent without colon", () => {
		assert.deepStrictEqual(parseDependencies("Parent #50"), [50]);
	});

	it("returns empty for null/undefined", () => {
		assert.deepStrictEqual(parseDependencies(null), []);
		assert.deepStrictEqual(parseDependencies(undefined), []);
	});

	it("returns empty for body with no deps", () => {
		assert.deepStrictEqual(parseDependencies("Just a normal issue body"), []);
	});

	it("ignores strikethrough deps", () => {
		assert.deepStrictEqual(parseDependencies("~~Depends on: #43~~"), []);
	});

	it("ignores HTML comment deps", () => {
		assert.deepStrictEqual(parseDependencies("<!-- Depends on: #43 -->"), []);
	});

	it("deduplicates refs", () => {
		const body = "Depends on: #43\nDepends on: #43";
		assert.deepStrictEqual(parseDependencies(body), [43]);
	});
});
