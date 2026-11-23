import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { seatCredentialArgs } from "../src/seat-credentials.js";

it("answers only github.com HTTPS gets and masks inherited helpers", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "elenchus-credential-test-"));
  try {
    const secretReader = path.join(dir, "stub-security");
    writeFileSync(secretReader, "#!/bin/sh\nprintf '%s\\n' 'dummy-seat-value'\n");
    chmodSync(secretReader, 0o755);
    const config = seatCredentialArgs("-c", "test item");
    expect(config.slice(0, 3)).toEqual(["-c", "credential.helper=", "-c"]);
    const helper = config[3]!;
    expect(helper).toContain('host" = github.com');
    expect(helper).toContain("/usr/bin/security find-generic-password -s 'test item' -w");
    const fakeHelper = helper.replace("/usr/bin/security", secretReader);
    const args = [
      "-c", "credential.helper=!printf 'username=admin\\npassword=admin-dummy\\n\\n'",
      "-c", "credential.helper=",
      "-c", fakeHelper,
      "credential", "fill",
    ];
    const run = (host: string, protocol = "https") => spawnSync("git", args, {
      cwd: dir,
      input: `protocol=${protocol}\nhost=${host}\n\n`,
      encoding: "utf8",
      env: {
        ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false",
      },
    });
    const github = run("github.com");
    expect(github.status, github.stderr).toBe(0);
    expect(github.stdout).toContain("password=dummy-seat-value");
    expect(github.stdout).not.toContain("admin-dummy");
    for (const result of [run("example.com"), run("github.com.evil.test"), run("github.com", "http")]) {
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("dummy");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
