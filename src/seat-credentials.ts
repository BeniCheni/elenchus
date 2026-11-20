import { shellQuote } from "./quote.js";

export function seatCredentialArgs(flag: "--config" | "-c", service: string): string[] {
  return [flag, "credential.helper=", flag, `credential.helper=${helper(service)}`];
}

function readToken(service: string): string {
  return `/usr/bin/security find-generic-password -s ${shellQuote(service)} -w`;
}

function helper(service: string): string {
  // This helper answers Git's credential protocol. Git receives the password
  // on stdout, and ignores this helper for every other host and operation.
  return [
    "!f() {",
    "set +x;",
    '[ "$1" = get ] || return 0;',
    "protocol= host=;",
    "while IFS= read -r line && [ -n \"$line\" ]; do",
    'case "$line" in protocol=*) protocol=${line#protocol=} ;; host=*) host=${line#host=} ;; esac;',
    "done;",
    '[ "$protocol" = https ] && [ "$host" = github.com ] || return 0;',
    `elenchus_seat_token=$(${readToken(service)}) && [ -n "$elenchus_seat_token" ] || return 1;`,
    "printf 'username=x-access-token\\npassword=%s\\n\\n' \"$elenchus_seat_token\";",
    "}; f",
  ].join(" ");
}

export function withSeatToken(service: string, command: string): string {
  return `(set +x; elenchus_seat_token=$(${readToken(service)}) && [ -n "$elenchus_seat_token" ] && GH_TOKEN="$elenchus_seat_token" ${command})`;
}
