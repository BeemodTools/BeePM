import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"
import { api, login, makePack, publish, setup } from "./helpers.js"

let t
let alice // owner of @alice/*
let bob
let boss // an admin (BOOTSTRAP_ADMINS)
before(async () => {
    t = await setup({ PUBLISHES_PER_HOUR: "100", PUBLISHES_PER_DAY: "100" })
    alice = (await login(t, t.profile({ username: "alice" }), { handle: "alice" })).token
    bob = (await login(t, t.profile({ username: "bob" }), { handle: "bob" })).token
    boss = (await login(t, t.profile({ username: "boss" }), { handle: "boss" })).token
})
after(() => t.cleanup())

test("publish, read the packument, and download the exact bytes", async () => {
    const file = await makePack(t.dir, {
        id: "ALICE_ITEMS",
        manifest: {
            name: "alice-items",
            version: "1.0.0",
            display_name: "Alice's Items",
            compatibleWith: ">=2.4.40,<2.5",
        },
    })
    const res = await publish(t, alice, file)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.name, "@alice/alice-items")
    assert.equal(res.body.created, true)

    const doc = await api(t, null, "GET", "/v1/packages/@alice/alice-items")
    assert.equal(doc.status, 200)
    assert.equal(doc.body.beeId, "ALICE_ITEMS")
    assert.equal(doc.body.displayName, "Alice's Items")
    assert.equal(doc.body.latest, "1.0.0")
    assert.deepEqual(doc.body.owners, ["alice"])
    const v = doc.body.versions["1.0.0"]
    assert.equal(v.compatibleWith, ">=2.4.40 <2.5")
    assert.equal(v.publishedBy, "alice")

    const bytes = await readFile(file)
    assert.equal(v.sha256, createHash("sha256").update(bytes).digest("hex"))
    const redirect = await api(
        t,
        null,
        "GET",
        "/v1/packages/alice/alice-items/versions/1.0.0/download",
    )
    assert.equal(redirect.status, 302)
    const download = await t.app.inject({
        method: "GET",
        url: new URL(redirect.headers.location).pathname,
    })
    assert.equal(download.statusCode, 200)
    assert.ok(download.rawPayload.equals(bytes))

    const list = await api(t, null, "GET", "/v1/packages?q=alice")
    assert.equal(list.body.total, 1)
    assert.equal(list.body.packages[0].downloads, 1)
    assert.deepEqual((await api(t, null, "GET", "/v1/lookup?name=alice-items")).body.packages, [
        "@alice/alice-items",
    ])
    assert.deepEqual((await api(t, null, "GET", "/v1/lookup?beeId=alice_items")).body.packages, [
        "@alice/alice-items",
    ])
})

test("versions are immutable and the BEE2 ID can't change or be reused", async () => {
    const again = await publish(
        t,
        alice,
        await makePack(t.dir, { id: "ALICE_ITEMS", manifest: { name: "alice-items" } }),
    )
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, "version_exists")

    const otherId = await publish(
        t,
        alice,
        await makePack(t.dir, {
            id: "DIFFERENT",
            manifest: { name: "alice-items", version: "1.1.0" },
        }),
    )
    assert.equal(otherId.body.error.code, "bee_id_mismatch")

    const stolenId = await publish(
        t,
        bob,
        await makePack(t.dir, { id: "ALICE_ITEMS", manifest: { name: "bob-copy" } }),
    )
    assert.equal(stolenId.status, 409)
    assert.equal(stolenId.body.error.code, "bee_id_taken")
})

test("only owners publish; new packages go in your own scope", async () => {
    const intoAlice = await publish(
        t,
        bob,
        await makePack(t.dir, {
            id: "BOB_X",
            manifest: { name: "@alice/alice-items", version: "2.0.0" },
        }),
    )
    assert.equal(intoAlice.status, 403)

    const wrongScope = await publish(
        t,
        bob,
        await makePack(t.dir, { id: "BOB_Y", manifest: { name: "thing", author: "Alice" } }),
    )
    assert.equal(wrongScope.body.error.code, "wrong_scope")

    // Adding bob as an owner lets him publish
    assert.equal(
        (await api(t, alice, "PUT", "/v1/packages/@alice/alice-items/owners/bob")).status,
        200,
    )
    const asOwner = await publish(
        t,
        bob,
        await makePack(t.dir, {
            id: "ALICE_ITEMS",
            manifest: { name: "alice-items", author: "alice", version: "1.1.0" },
        }),
    )
    assert.equal(asOwner.status, 200, JSON.stringify(asOwner.body))
    assert.equal(
        (await api(t, null, "GET", "/v1/packages/@alice/alice-items")).body.latest,
        "1.1.0",
    )

    assert.equal(
        (await api(t, bob, "DELETE", "/v1/packages/@alice/alice-items/owners/bob")).status,
        200,
    )
    const lastOwner = await api(t, alice, "DELETE", "/v1/packages/@alice/alice-items/owners/alice")
    assert.equal(lastOwner.body.error.code, "last_owner")
})

test("the publish check runs the registry's rules without a file", async () => {
    const check = (token, manifest, beeId) =>
        api(t, token, "POST", "/v1/publish/check", { manifest, beeId })

    const fresh = await check(alice, { name: "brand-new", version: "1.0.0" }, "ALICE_NEW")
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body))
    assert.deepEqual(fresh.body, { name: "@alice/brand-new", version: "1.0.0", created: true })

    const codes = async (token, manifest, beeId) =>
        (await check(token, manifest, beeId)).body.error.code
    assert.equal(
        await codes(bob, { name: "@alice/alice-items", version: "9.0.0" }, "ALICE_ITEMS"),
        "not_owner",
    )
    assert.equal(
        await codes(bob, { name: "@nobody/thing", version: "1.0.0" }, "BOB_Z"),
        "wrong_scope",
    )
    assert.equal(
        await codes(alice, { name: "alice-items", version: "1.0.0" }, "ALICE_ITEMS"),
        "version_exists",
    )
    assert.equal(
        await codes(alice, { name: "alice-items", version: "9.0.0" }, "OTHER_ID"),
        "bee_id_mismatch",
    )
    assert.equal(
        await codes(bob, { name: "bob-copy", version: "1.0.0" }, "ALICE_ITEMS"),
        "bee_id_taken",
    )
    assert.equal(
        await codes(
            alice,
            { name: "with-deps", version: "1.0.0", dependencies: { "@alice/missing": "*" } },
            "ALICE_DEPS",
        ),
        "unknown_dependency",
    )
    const invalid = await check(alice, { name: "x", version: "not-a-version" }, "ALICE_X")
    assert.equal(invalid.body.error.code, "invalid_package")
    assert.ok(invalid.body.error.details.problems[0].startsWith("bee-package.json:"))
})

test("bad packages are rejected with every problem listed", async () => {
    const res = await publish(
        t,
        alice,
        await makePack(t.dir, {
            info: '"Name" "no id"',
            manifest: { version: "one" },
            extra: { "payload.exe": "MZ" },
        }),
    )
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, "invalid_package")
    assert.equal(res.body.error.details.problems.length, 3)
    assert.deepEqual(res.body.error.details.disallowed, ["payload.exe"])
})

test("dependencies must exist; old @author/BEE2_ID keys are mapped to the package", async () => {
    const missing = await publish(
        t,
        bob,
        await makePack(t.dir, {
            id: "BOB_DEPS",
            manifest: { name: "bob-deps", dependencies: { "@alice/nothing": "*" } },
        }),
    )
    assert.equal(missing.body.error.code, "unknown_dependency")

    const unsatisfiable = await publish(
        t,
        bob,
        await makePack(t.dir, {
            id: "BOB_DEPS",
            manifest: { name: "bob-deps", dependencies: { "@alice/alice-items": "^2.0.0" } },
        }),
    )
    assert.equal(unsatisfiable.body.error.code, "unsatisfiable_dependency")

    const ok = await publish(
        t,
        bob,
        await makePack(t.dir, {
            id: "BOB_DEPS",
            manifest: {
                name: "bob-deps",
                dependencies: { "@Alice/ALICE_ITEMS": ">=1.0.0", "@beemod/BEE2_CLEAN_STYLE": "*" },
            },
        }),
    )
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const doc = await api(t, null, "GET", "/v1/packages/@bob/bob-deps")
    assert.deepEqual(doc.body.versions["1.0.0"].dependencies, {
        "@alice/alice-items": ">=1.0.0",
        "@beemod/BEE2_CLEAN_STYLE": "*",
    })
})

test("yank, deprecate and unpublish", async () => {
    await publish(
        t,
        alice,
        await makePack(t.dir, {
            id: "ALICE_ITEMS",
            manifest: { name: "alice-items", version: "1.2.0" },
        }),
    )
    let doc = (await api(t, null, "GET", "/v1/packages/@alice/alice-items")).body
    assert.equal(doc.latest, "1.2.0")

    assert.equal(
        (
            await api(t, bob, "POST", "/v1/packages/@alice/alice-items/versions/1.2.0/yank", {
                reason: "x",
            })
        ).status,
        403,
    )
    assert.equal(
        (
            await api(t, alice, "POST", "/v1/packages/@alice/alice-items/versions/1.2.0/yank", {
                reason: "Broken",
            })
        ).status,
        200,
    )
    doc = (await api(t, null, "GET", "/v1/packages/@alice/alice-items")).body
    assert.equal(doc.latest, "1.1.0")
    assert.equal(doc.versions["1.2.0"].yanked, true)
    assert.equal(doc.versions["1.2.0"].yankReason, "Broken")
    await api(t, alice, "DELETE", "/v1/packages/@alice/alice-items/versions/1.2.0/yank")

    await api(t, alice, "PUT", "/v1/packages/@alice/alice-items/deprecation", { message: "Use v2" })
    await api(t, alice, "PUT", "/v1/packages/@alice/alice-items/deprecation", {
        message: "Old",
        version: "1.0.0",
    })
    doc = (await api(t, null, "GET", "/v1/packages/@alice/alice-items")).body
    assert.equal(doc.deprecated, "Use v2")
    assert.equal(doc.versions["1.0.0"].deprecated, "Old")

    // bob-deps needs >=1.0.0, and 1.0.0-1.2.0 all satisfy it: unpublishing is blocked
    const blocked = await api(t, alice, "DELETE", "/v1/packages/@alice/alice-items/versions/1.2.0")
    assert.equal(blocked.body.error.code, "has_dependents")

    await publish(
        t,
        alice,
        await makePack(t.dir, { id: "ALICE_SOLO", manifest: { name: "solo", version: "0.1.0" } }),
    )
    assert.equal(
        (await api(t, alice, "DELETE", "/v1/packages/@alice/solo/versions/0.1.0")).status,
        200,
    )
    assert.equal((await api(t, null, "GET", "/v1/packages/@alice/solo")).body.latest, null)
    assert.equal(
        (await api(t, null, "GET", "/v1/packages/@alice/solo/versions/0.1.0/download")).status,
        404,
    )
    const reuse = await publish(
        t,
        alice,
        await makePack(t.dir, { id: "ALICE_SOLO", manifest: { name: "solo", version: "0.1.0" } }),
    )
    assert.equal(reuse.body.error.code, "version_exists")
    assert.match(reuse.body.error.message, /can't be reused/)
})

test("new accounts can't publish yet, and publish limits apply", async () => {
    const fresh = (
        await login(t, t.profile({ provider: "discord", username: "fresh", ageDays: 2 }), {
            provider: "discord",
            handle: "fresh",
        })
    ).token
    const me = await api(t, fresh, "GET", "/v1/me")
    assert.equal(me.body.canPublish, false)
    const res = await api(t, fresh, "POST", "/v1/uploads", { size: 10, sha256: "a".repeat(64) })
    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, "account_too_new")

    const limited = await setup({ PUBLISHES_PER_HOUR: "2" })
    try {
        const token = (
            await login(limited, limited.profile({ username: "spammer" }), { handle: "spammer" })
        ).token
        for (let i = 0; i < 2; i++) {
            assert.equal(
                (
                    await api(limited, token, "POST", "/v1/uploads", {
                        size: 10,
                        sha256: "a".repeat(64),
                    })
                ).status,
                200,
            )
        }
        assert.equal(
            (await api(limited, token, "POST", "/v1/uploads", { size: 10, sha256: "a".repeat(64) }))
                .status,
            429,
        )
    } finally {
        await limited.cleanup()
    }
})

test("finalize checks the upload against what was declared", async () => {
    const file = await makePack(t.dir, { id: "CHECKSUM_TEST", manifest: { name: "checksum" } })
    const bytes = await readFile(file)
    const start = await api(t, alice, "POST", "/v1/uploads", {
        size: bytes.length,
        sha256: "0".repeat(64),
    })
    const early = await api(t, alice, "POST", `/v1/uploads/${start.body.id}/finalize`)
    assert.equal(early.body.error.code, "not_uploaded")

    await t.app.inject({
        method: "PUT",
        url: new URL(start.body.upload.url).pathname,
        headers: start.body.upload.headers,
        payload: bytes,
    })
    const res = await api(t, alice, "POST", `/v1/uploads/${start.body.id}/finalize`)
    assert.equal(res.body.error.code, "checksum_mismatch")
    assert.equal((await api(t, bob, "POST", `/v1/uploads/${start.body.id}/finalize`)).status, 404)
})

test("admins can remove and restore packages", async () => {
    const admin = boss
    assert.equal((await api(t, alice, "DELETE", "/v1/admin/packages/@bob/bob-deps")).status, 403)
    assert.equal(
        (await api(t, admin, "DELETE", "/v1/admin/packages/@bob/bob-deps", { reason: "Spam" }))
            .status,
        200,
    )
    assert.equal((await api(t, null, "GET", "/v1/packages/@bob/bob-deps")).status, 404)
    assert.equal(
        (await api(t, admin, "GET", "/v1/packages/@bob/bob-deps")).body.removed.reason,
        "Spam",
    )
    assert.equal(
        (await api(t, admin, "POST", "/v1/admin/packages/@bob/bob-deps/restore")).status,
        200,
    )
    assert.equal((await api(t, null, "GET", "/v1/packages/@bob/bob-deps")).status, 200)

    const renamed = await api(t, admin, "PATCH", "/v1/admin/users/bob", { handle: "robert" })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
    assert.equal((await api(t, null, "GET", "/v1/packages/@robert/bob-deps")).status, 200)
    const downloaded = await api(
        t,
        null,
        "GET",
        "/v1/packages/@robert/bob-deps/versions/1.0.0/download",
    )
    assert.equal(downloaded.status, 302) // files keep their old storage keys

    assert.equal(
        (
            await api(t, admin, "PATCH", "/v1/admin/users/robert", {
                banned: true,
                banReason: "test",
            })
        ).status,
        200,
    )
    assert.equal((await api(t, bob, "GET", "/v1/me")).status, 401) // tokens revoked
    const audit = await api(t, admin, "GET", "/v1/admin/audit")
    assert.ok(audit.body.entries.some((e) => e.action === "admin.user.update"))
})

test("a removed package frees its BEE2 ID, and admins still find it", async () => {
    const admin = boss
    const pack = (name, id = "ALICE_GADGETS") =>
        makePack(t.dir, { id, manifest: { name, version: "1.0.0" } })
    assert.equal((await publish(t, alice, await pack("old-gadgets"))).status, 200)
    const removed = await api(t, admin, "DELETE", "/v1/admin/packages/@alice/old-gadgets", {
        reason: "Renamed",
    })
    assert.equal(removed.status, 200)

    // Only admins find it, marked as removed
    const names = (res) => res.body.packages.map((p) => p.name)
    assert.ok(
        !names(await api(t, alice, "GET", "/v1/packages?q=gadgets")).includes("@alice/old-gadgets"),
    )
    const found = (await api(t, admin, "GET", "/v1/packages?q=gadgets")).body.packages
    assert.equal(found.find((p) => p.name === "@alice/old-gadgets")?.removed?.reason, "Renamed")

    // Its BEE2 ID can be used again; its name stays taken
    const renamed = await publish(t, alice, await pack("new-gadgets"))
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
    const sameName = await publish(t, alice, await pack("old-gadgets", "OTHER_GADGETS"))
    assert.equal(sameName.body.error.code, "package_removed")

    // Restoring it would give two packages the same ID
    const restored = await api(t, admin, "POST", "/v1/admin/packages/@alice/old-gadgets/restore")
    assert.equal(restored.status, 409)
    assert.equal(restored.body.error.code, "bee_id_taken")
    assert.match(restored.body.error.message, /@alice\/new-gadgets uses the BEE2 ID ALICE_GADGETS/)
})
