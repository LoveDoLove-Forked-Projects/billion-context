// Install-gate tests (scripts/check-dist-ready.mjs): the dist × checkout
// matrix, the unconditional pack/publish requirement, and the filesystem
// markers the verdict reads (#2471).

import { test } from "node:test";
import assert from "node:assert/strict";
const gateSpec = "../scripts/check-dist-ready.mjs";
const { distEntryReady, selfBuildableCheckout, distReadyVerdict } = await import(gateSpec) as {
    distEntryReady: (dir: string) => boolean;
    selfBuildableCheckout: (dir: string) => boolean;
    distReadyVerdict: (state: { distReady: boolean; selfBuildable: boolean; npmCommand?: string }) => { ok: boolean; reason: string };
};
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";

test("matrix: dist present passes in every context, pack included", () => {
    assert.equal(distReadyVerdict({ distReady: true, selfBuildable: false, npmCommand: undefined }).ok, true);
    assert.equal(distReadyVerdict({ distReady: true, selfBuildable: false, npmCommand: "pack" }).ok, true);
});

test("matrix: dist missing + dev checkout passes install-time prepare", () => {
    assert.equal(distReadyVerdict({ distReady: false, selfBuildable: true, npmCommand: "install" }).ok, true);
});

test("matrix: dist missing + fetched source copy fails with guidance", () => {
    const verdict = distReadyVerdict({ distReady: false, selfBuildable: false, npmCommand: undefined });
    assert.equal(verdict.ok, false);
});

test("pack/publish requires dist unconditionally, dev checkout included", () => {
    assert.equal(distReadyVerdict({ distReady: false, selfBuildable: true, npmCommand: "pack" }).ok, false);
    assert.equal(distReadyVerdict({ distReady: false, selfBuildable: true, npmCommand: "publish" }).ok, false);
});

test("markers read the filesystem: dist/index.js and .git", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-distready-"));
    try {
        assert.equal(distEntryReady(root), false);
        assert.equal(selfBuildableCheckout(root), false);
        mkdirSync(path.join(root, "dist"));
        writeFileSync(path.join(root, "dist", "index.js"), "");
        assert.equal(distEntryReady(root), true);
        mkdirSync(path.join(root, ".git"));
        assert.equal(selfBuildableCheckout(root), true);
    } finally {
        rmrf(root);
    }
});
