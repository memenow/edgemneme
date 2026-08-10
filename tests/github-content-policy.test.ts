import { describe, expect, it } from "vitest";

import {
  GITHUB_BLOB_TRANSPORT_LIMIT_BYTES,
  classifyGitHubBlobBytes,
  classifyGitHubBlobPath
} from "../src/github/content-policy";

const encoder = new TextEncoder();

describe("GitHub blob content policy", () => {
  it.each([
    "node_modules/package/index.js",
    "vendor/library/source.rb",
    "dist/application.js",
    "build/generated/output.txt",
    "coverage/lcov.info",
    "generated/client.ts",
    ".next/server/app.js",
    "target/release/application",
    "public/application.min.js",
    "styles/site.min.css.map"
  ])("deterministically excludes generated path %s", (path) => {
    expect(classifyGitHubBlobPath({ path })).toMatchObject({
      action: "exclude",
      result: {
        disposition: "generated_excluded"
      }
    });
  });

  it.each([
    "assets/image.png",
    "docs/manual.pdf",
    "artifacts/archive.zip",
    "fonts/application.woff2",
    "bin/module.wasm",
    "lib/native.so",
    "classes/Application.class",
    "audio/theme.mp3"
  ])("deterministically excludes binary extension %s", (path) => {
    expect(classifyGitHubBlobPath({ path })).toEqual({
      action: "exclude",
      result: {
        disposition: "binary_excluded",
        reason: "known_binary_extension"
      }
    });
  });

  it("excludes only large lockfiles and keeps smaller lockfiles inspectable", () => {
    expect(
      classifyGitHubBlobPath({
        path: "pnpm-lock.yaml",
        byteLength: GITHUB_BLOB_TRANSPORT_LIMIT_BYTES
      })
    ).toEqual({
      action: "inspect",
      reason: "content_inspection_required"
    });
    expect(
      classifyGitHubBlobPath({
        path: "pnpm-lock.yaml",
        byteLength: GITHUB_BLOB_TRANSPORT_LIMIT_BYTES + 1
      })
    ).toEqual({
      action: "exclude",
      result: {
        disposition: "generated_excluded",
        reason: "large_lockfile"
      }
    });
  });

  it("marks an oversized non-lock blob as partial before transport", () => {
    expect(
      classifyGitHubBlobPath({
        path: "docs/large.txt",
        byteLength: GITHUB_BLOB_TRANSPORT_LIMIT_BYTES + 1
      })
    ).toEqual({
      action: "partial",
      result: {
        disposition: "partial",
        reason: "transport_limit_exceeded"
      }
    });
  });

  it("marks invalid declared path sizes as partial", () => {
    expect(classifyGitHubBlobPath({ path: "docs/readme.md", byteLength: -1 })).toEqual({
      action: "partial",
      result: {
        disposition: "partial",
        reason: "invalid_declared_size"
      }
    });
  });

  it.each([
    "Dockerfile",
    "Makefile",
    "Gemfile",
    "LICENSE",
    ".gitignore",
    "src/main.c",
    "src/main.cc",
    "src/main.cpp",
    "src/main.h",
    "src/main.hpp",
    "src/Program.cs",
    "lib/application.rb",
    "src/index.php",
    "Sources/App.swift",
    "lib/main.dart",
    "src/Main.scala",
    "lib/application.ex",
    "src/application.erl",
    "src/init.lua",
    "analysis/report.r",
    "src/Main.hs",
    "config/settings.xml",
    "data/records.csv",
    "schema/api.graphql",
    "proto/service.proto",
    "scripts/release.bash",
    "scripts/bootstrap.zsh",
    "scripts/setup.fish"
  ])("classifies clean text at %s as text", (path) => {
    const text = "name: EdgeMneme\nvalue: durable project context\n";

    expect(classifyGitHubBlobPath({ path })).toEqual({
      action: "inspect",
      reason: "content_inspection_required"
    });
    expect(classifyGitHubBlobBytes({ path, bytes: encoder.encode(text) })).toEqual({
      disposition: "text",
      reason: "strict_utf8_text",
      byteLength: encoder.encode(text).byteLength,
      text
    });
  });

  it("inspects an unknown extension instead of silently excluding it", () => {
    const text = "custom format with ordinary UTF-8 text\n";
    const path = "config/application.unknown-format";

    expect(classifyGitHubBlobPath({ path })).toEqual({
      action: "inspect",
      reason: "content_inspection_required"
    });
    expect(classifyGitHubBlobBytes({ path, bytes: encoder.encode(text) })).toMatchObject({
      disposition: "text",
      reason: "strict_utf8_text",
      text
    });
  });

  it("uses fatal UTF-8 decoding and treats invalid input as partial", () => {
    const result = classifyGitHubBlobBytes({
      path: "src/invalid.txt",
      bytes: Uint8Array.from([0xc3, 0x28])
    });

    expect(result).toEqual({
      disposition: "partial",
      reason: "invalid_utf8",
      byteLength: 2
    });
  });

  it("does not decode content from a path that is already excluded", () => {
    const bytes = Uint8Array.from([0xc3, 0x28]);

    expect(
      classifyGitHubBlobBytes({ path: "generated/invalid-utf8.ts", bytes })
    ).toEqual({
      disposition: "generated_excluded",
      reason: "generated_path",
      byteLength: bytes.byteLength
    });
  });

  it("excludes a NUL byte without putting content in the reason", () => {
    const secretMarker = "do-not-copy-this-body";
    const bytes = encoder.encode(`${secretMarker}\0tail`);
    const result = classifyGitHubBlobBytes({ path: "notes.txt", bytes });

    expect(result).toEqual({
      disposition: "binary_excluded",
      reason: "nul_byte",
      byteLength: bytes.byteLength
    });
    expect(result.reason).not.toContain(secretMarker);
  });

  it("excludes known binary content even when the extension looks textual", () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00
    ]);

    expect(classifyGitHubBlobBytes({ path: "assets/image.txt", bytes: png })).toEqual({
      disposition: "binary_excluded",
      reason: "known_binary_format",
      byteLength: png.byteLength
    });
  });

  it("excludes an abnormal control-byte ratio", () => {
    const bytes = Uint8Array.from([
      ...encoder.encode("ordinary text"),
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06
    ]);

    expect(classifyGitHubBlobBytes({ path: "notes.txt", bytes })).toEqual({
      disposition: "binary_excluded",
      reason: "excessive_control_bytes",
      byteLength: bytes.byteLength
    });
  });

  it("treats a small amount of suspicious control data as partial", () => {
    const bytes = Uint8Array.from([...encoder.encode("x".repeat(100)), 0x01]);

    expect(classifyGitHubBlobBytes({ path: "notes.txt", bytes })).toEqual({
      disposition: "partial",
      reason: "ambiguous_control_bytes",
      byteLength: bytes.byteLength
    });
  });

  it("accepts exactly 64 KiB but reports larger fetched input as partial", () => {
    const boundary = encoder.encode("x".repeat(GITHUB_BLOB_TRANSPORT_LIMIT_BYTES));
    const oversized = encoder.encode("x".repeat(GITHUB_BLOB_TRANSPORT_LIMIT_BYTES + 1));

    expect(classifyGitHubBlobBytes({ path: "boundary.txt", bytes: boundary })).toMatchObject({
      disposition: "text",
      byteLength: GITHUB_BLOB_TRANSPORT_LIMIT_BYTES
    });
    expect(classifyGitHubBlobBytes({ path: "oversized.txt", bytes: oversized })).toEqual({
      disposition: "partial",
      reason: "transport_limit_exceeded",
      byteLength: GITHUB_BLOB_TRANSPORT_LIMIT_BYTES + 1
    });
  });

  it("reports a declared-size mismatch as partial", () => {
    const bytes = encoder.encode("plain text");

    expect(
      classifyGitHubBlobBytes({
        path: "notes.txt",
        bytes,
        declaredByteLength: bytes.byteLength + 1
      })
    ).toEqual({
      disposition: "partial",
      reason: "declared_size_mismatch",
      byteLength: bytes.byteLength
    });
  });

  it("reports an invalid declared byte length as partial", () => {
    const bytes = encoder.encode("plain text");

    expect(
      classifyGitHubBlobBytes({ path: "notes.txt", bytes, declaredByteLength: -1 })
    ).toEqual({
      disposition: "partial",
      reason: "invalid_declared_size",
      byteLength: bytes.byteLength
    });
  });

  it("returns safe, enumerated reasons for all non-text results", () => {
    const body = "sensitive-marker-that-must-not-appear-in-reasons";
    const results = [
      classifyGitHubBlobPath({ path: `generated/${body}.js` }),
      classifyGitHubBlobPath({ path: `${body}.png` }),
      classifyGitHubBlobBytes({
        path: `${body}.txt`,
        bytes: Uint8Array.from([0xc3, 0x28])
      })
    ];

    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(body);
    }
  });
});
