// Run after installing the versions named in scripts/person-recruiter/README.md
// into a private test runtime; no new application dependency is needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const runtime = path.resolve(
  process.env.UI_TEST_RUNTIME || ".superpowers/ui-runtime",
);
const req = createRequire(path.join(runtime, "package.json"));
const React = req("react"),
  { create, act } = req("react-test-renderer"),
  { build } = req("esbuild");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.document = {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const dir = mkdtempSync(path.join(os.tmpdir(), "person-drawer-"));
const output = path.join(dir, "drawer.cjs");
await build({
  entryPoints: ["components/dashboard/candidates/CandidateDrawer.tsx"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  logLevel: "silent",
  plugins: [
    {
      name: "sealed-drawer-fixture",
      setup(b) {
        b.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
          path: req.resolve(args.path),
          external: true,
        }));
        b.onResolve({ filter: /^@\// }, (args) => ({
          path: args.path,
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export default function Empty(){return null};export const useDash=()=>({token:'synthetic'});export const StageSelect=Empty;export const fmtDue=()=>'';export const companyKey=()=>'';export const companySlug=()=>null;export const slugsToAsk=()=>[];export const VERDICT_LABEL={};export const ROLE_FOCUS_OPTIONS=[];export const WORKPLACE_OPTIONS=[];export const SALARY_BAND_OPTIONS=[];export const VISA_OPTIONS=[];`,
          loader: "js",
        }));
      },
    },
  ],
});
const Drawer = req(output).default;
const detail = (key) => ({
  key,
  name: "Synthetic Person",
  headline: null,
  location: null,
  linkedinUrl: null,
  photoUrl: null,
  about: null,
  source: "sourced",
  shortlisted: false,
  viaTT: false,
  alsoSourced: false,
  provenance: "Synthetic",
  contact: {
    email: `${key}@example.test`,
    phone: null,
    github: null,
    otherEmails: [],
  },
  bestTag: null,
  bestTagLabel: null,
  followUp: null,
  pipeline: [],
  experience: [],
  education: [],
  skills: [],
  resumeUrl: null,
  resumeName: null,
  hasResume: false,
  addedAt: "2026-01-01",
});
const button = (tree, cls) =>
  tree.root.findAll((x) => x.type === "button" && x.props.className === cls)[0];
const props = (key) => ({ candKey: key, onClose() {}, initialTab: "profile" });
try {
  await test("navigating away from a pending contact save resets the new person controls", async () => {
    let tree, finish, savePromise;
    globalThis.fetch = async (url, init = {}) =>
      init.method === "PUT"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Response.json(detail(String(url).split("/").at(-1)));
    try {
      await act(async () => {
        tree = create(React.createElement(Drawer, props("net_A")));
      });
      await act(async () => {
        button(tree, "cv2d-edit").props.onClick();
      });
      await act(async () => {
        savePromise = button(tree, "cv2d-save").props.onClick();
      });
      assert.equal(button(tree, "cv2d-save").props.disabled, true);
      await act(async () => {
        tree.update(React.createElement(Drawer, props("net_B")));
      });
      await act(async () => {
        button(tree, "cv2d-edit").props.onClick();
      });
      assert.equal(
        button(tree, "cv2d-save").props.disabled,
        false,
        "B must not inherit the pending A save",
      );
      await act(async () => {
        finish(Response.json({ contact: { email: "late-a@example.test" } }));
        await savePromise;
      });
      assert.equal(
        tree.root.findByProps({ placeholder: "Email" }).props.value,
        "net_B@example.test",
      );
    } finally {
      if (finish)
        await act(async () => {
          finish(Response.json({ contact: { email: "late-a@example.test" } }));
          await savePromise;
        });
      if (tree) await act(async () => tree.unmount());
    }
  });

  await test("an old save cannot clear a newer candidate save or overwrite its contact", async () => {
    let tree;
    const pending = [];
    const jobs = [];
    globalThis.fetch = async (url, init = {}) =>
      init.method === "PUT"
        ? new Promise((resolve) => pending.push(resolve))
        : Response.json(detail(String(url).split("/").at(-1)));
    try {
      await act(async () => {
        tree = create(React.createElement(Drawer, props("net_A")));
      });
      await act(async () => button(tree, "cv2d-edit").props.onClick());
      await act(async () => {
        jobs.push(button(tree, "cv2d-save").props.onClick());
      });
      await act(async () =>
        tree.update(React.createElement(Drawer, props("net_B"))),
      );
      await act(async () => button(tree, "cv2d-edit").props.onClick());
      await act(async () => {
        jobs.push(button(tree, "cv2d-save").props.onClick());
      });
      await act(async () => {
        pending[0](Response.json({ contact: detail("net_A").contact }));
        await jobs[0];
      });
      assert.equal(
        button(tree, "cv2d-save").props.disabled,
        true,
        "A must not finish B loading state",
      );
      assert.equal(
        tree.root.findByProps({ placeholder: "Email" }).props.value,
        "net_B@example.test",
      );
      await act(async () => {
        pending[1](Response.json({ contact: detail("net_B").contact }));
        await jobs[1];
      });
      await act(async () => button(tree, "cv2d-edit").props.onClick());
      assert.equal(
        tree.root.findByProps({ placeholder: "Email" }).props.value,
        "net_B@example.test",
      );
    } finally {
      await act(async () => {
        for (const finish of pending)
          finish(Response.json({ contact: detail("net_B").contact }));
        await Promise.all(jobs);
      });
      if (tree) await act(async () => tree.unmount());
    }
  });
  await test("a late error body cannot add an error to the next candidate", async () => {
    let tree, finish, job;
    globalThis.fetch = async (url, init = {}) =>
      init.method === "PUT"
        ? {
            ok: false,
            json: () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
          }
        : Response.json(detail(String(url).split("/").at(-1)));
    try {
      await act(async () => {
        tree = create(React.createElement(Drawer, props("net_A")));
      });
      await act(async () => button(tree, "cv2d-edit").props.onClick());
      await act(async () => {
        job = button(tree, "cv2d-save").props.onClick();
      });
      assert.equal(typeof finish, "function");
      await act(async () =>
        tree.update(React.createElement(Drawer, props("net_B"))),
      );
      await act(async () => button(tree, "cv2d-edit").props.onClick());
      await act(async () => {
        finish({ error: "invalid_email" });
        await job;
      });
      assert.equal(
        tree.root.findAllByProps({ className: "cv2d-err" }).length,
        0,
      );
    } finally {
      if (finish)
        await act(async () => {
          finish({ error: "invalid_email" });
          await job;
        });
      if (tree) await act(async () => tree.unmount());
    }
  });
  await test("an unchanged failed edit retries the same receipt ID, but changed data gets a new ID", async () => {
    let tree;
    const ids = [];
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === "PUT") {
        ids.push(init.headers["Idempotency-Key"]);
        return Response.json({ error: "synthetic_failure" }, { status: 503 });
      }
      return Response.json(detail(String(url).split("/").at(-1)));
    };
    try {
      await act(async () => {
        tree = create(React.createElement(Drawer, props("net_A")));
      });
      await act(async () => button(tree, "cv2d-edit").props.onClick());
      await act(async () => button(tree, "cv2d-save").props.onClick());
      await act(async () => button(tree, "cv2d-save").props.onClick());
      assert.equal(ids[0], ids[1]);
      await act(async () =>
        tree.root
          .findByProps({ placeholder: "Email" })
          .props.onChange({ target: { value: "changed@example.test" } }),
      );
      await act(async () => button(tree, "cv2d-save").props.onClick());
      assert.notEqual(ids[1], ids[2]);
    } finally {
      if (tree) await act(async () => tree.unmount());
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
