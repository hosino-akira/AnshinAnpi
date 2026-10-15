#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

command -v flock || {
  echo "install-ci.sh の実行には Linux の flock が必要です。" >&2
  exit 69
}
command -v timeout || {
  echo "install-ci.sh の実行には GNU timeout が必要です。" >&2
  exit 69
}
command -v curl || {
  echo "固定した配布ファイルの事前確認に curl が必要です。" >&2
  exit 69
}
command -v sha256sum || {
  echo "キャッシュとインストールの検証に sha256sum が必要です。" >&2
  exit 69
}

runtime_root="${SITES_PROJECT_ROOT}/.sites-runtime"
expected_home="${runtime_root}/home"
expected_cache="${runtime_root}/npm-cache"

echo "[sites] 書き込み可能なインストール環境を確認しています。"
if [[ "${HOME}" != "${expected_home}" ]]; then
  echo "HOME の想定値は ${expected_home}、現在の値は ${HOME} です。" >&2
  exit 78
fi
actual_cache="$(npm config get cache)"
if [[ "${actual_cache}" != "${expected_cache}" ]]; then
  echo "npm キャッシュの想定値は ${expected_cache}、現在の値は ${actual_cache} です。" >&2
  exit 78
fi
touch "${HOME}/.sites-write-test" "${expected_cache}/.sites-write-test"
rm -f "${HOME}/.sites-write-test" "${expected_cache}/.sites-write-test"
echo "[sites] 環境確認に成功しました：HOME=${HOME}、キャッシュ=${expected_cache}"

lock_file="${runtime_root}/install.lock"
exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "${SITES_PROJECT_ROOT} では依存関係のインストールが既に実行中です。" >&2
  exit 75
fi

# この補助スクリプト以外から起動したインストールも確認します。
# Linux の /proc でコマンドと作業場所を確認し、プロセス名だけで判定しません。
for process in /proc/[0-9]*; do
  pid="${process##*/}"
  [[ "${pid}" != "$$" && "${pid}" != "${PPID}" ]] || continue
  process_cwd="$(readlink -f "${process}/cwd" || true)"
  [[ "${process_cwd}" == "${SITES_PROJECT_ROOT}" ]] || continue
  process_command="$(tr '\0' ' ' <"${process}/cmdline" || true)"
  if [[ "${process_command}" == *"npm ci"* ]]; then
    echo "${SITES_PROJECT_ROOT} で別の npm ci を検出したため、重複実行を停止します。" >&2
    exit 75
  fi
done

lockfile_sha256="$(sha256sum "${SITES_PROJECT_ROOT}/package-lock.json" | awk '{print $1}')"
use_seeded_cache=0
seed_cache="${SITES_NPM_CACHE_SEED:-}"
if [[ -n "${seed_cache}" && -d "${seed_cache}" ]]; then
  seed_lockfile_sha256="$(cat "${seed_cache}/.sites-lockfile-sha256" || true)"
  if [[ "${seed_lockfile_sha256}" == "${lockfile_sha256}" ]]; then
    echo "[sites] イメージに同梱された npm キャッシュを復元しています。"
    cp -a "${seed_cache}/." "${expected_cache}/"
    use_seeded_cache=1
    echo "[sites] 同梱キャッシュが一致しました。必要に応じてレジストリーも使用します。"
  else
    echo "[sites] 同梱キャッシュとロックファイルが一致しないため、ネットワークから取得します。"
  fi
fi

locked_vinext_output="$({ node --input-type=module - "${SITES_PROJECT_ROOT}/package-lock.json" <<'NODE'
import { readFile } from "node:fs/promises";

const lock = JSON.parse(await readFile(process.argv[2], "utf8"));
const vinext = lock.packages?.["node_modules/vinext"];
if (!vinext?.resolved || !vinext?.integrity) {
  throw new Error("package-lock.json に取得先と整合性検証値が固定された vinext 配布ファイルがありません。");
}
console.log(vinext.resolved);
console.log(vinext.integrity);
NODE
})" || {
  echo "package-lock.json から vinext の配布情報を読み取れませんでした。" >&2
  exit 65
}
mapfile -t locked_vinext <<<"${locked_vinext_output}"
if [[ "${#locked_vinext[@]}" -ne 2 ]]; then
  echo "package-lock.json には vinext の URL と整合性検証値が 1 組必要です。" >&2
  exit 65
fi

locked_tarball="${locked_vinext[0]}"
locked_integrity="${locked_vinext[1]}"

if [[ "${use_seeded_cache}" == "0" ]]; then
  registry="$(npm config get registry)"
  preflight_url="$({ node --input-type=module - "${locked_tarball}" "${registry}" <<'NODE'
const locked = new URL(process.argv[2]);
const registry = new URL(process.argv[3]);
if (locked.hostname === "registry.npmjs.org") {
  locked.protocol = registry.protocol;
  locked.host = registry.host;
  locked.pathname = `${registry.pathname.replace(/\/$/, "")}${locked.pathname}`;
}
process.stdout.write(locked.href);
NODE
})" || {
  echo "固定した配布ファイルの事前確認 URL を作成できませんでした。" >&2
  exit 65
  }

  preflight_dir="${runtime_root}/preflight"
  preflight_tarball="${preflight_dir}/vinext.tgz"
  mkdir -p "${preflight_dir}"

  echo "[sites] 固定した vinext 配布ファイルを取得しています。"
  curl \
    --fail \
    --location \
    --silent \
    --show-error \
    --retry 0 \
    --connect-timeout 15 \
    --max-time 120 \
    --output "${preflight_tarball}" \
    "${preflight_url}"

  echo "[sites] vinext 配布ファイルの整合性を検証しています。"
  node --input-type=module - "${preflight_tarball}" "${locked_integrity}" <<'NODE'
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [algorithm, expected] = process.argv[3].split("-", 2);
if (!algorithm || !expected) {
  throw new Error(`対応していない整合性検証値です：${process.argv[3]}`);
}
const actual = createHash(algorithm)
  .update(await readFile(process.argv[2]))
  .digest("base64");
if (actual !== expected) {
  throw new Error(`vinext 配布ファイルの ${algorithm} 検証値が一致しません。`);
}
NODE
  echo "[sites] ネットワークと整合性の事前確認に成功しました。"
fi

echo "[sites] 制限時間を設けて npm ci を 1 回実行します。"
export NPM_CONFIG_MAXSOCKETS=1
export NPM_CONFIG_FETCH_RETRIES=0
export NPM_CONFIG_FETCH_TIMEOUT=30000
npm_ci_args=(ci --cache "${expected_cache}")
if [[ "${use_seeded_cache}" == "1" ]]; then
  npm_ci_args+=(--prefer-offline)
fi
timeout \
  --signal=TERM \
  --kill-after="${SITES_INSTALL_KILL_AFTER:-15s}" \
  "${SITES_INSTALL_TIMEOUT:-8m}" \
  npm "${npm_ci_args[@]}"

vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "npm ci は成功しましたが、node_modules/.bin/vinext が見つかりません。" >&2
  exit 69
fi

node --input-type=module - "${SITES_PROJECT_ROOT}/node_modules/.sites-install.json" "${lockfile_sha256}" <<'NODE'
import { writeFile } from "node:fs/promises";

await writeFile(
  process.argv[2],
  `${JSON.stringify({
    lockfile_sha256: process.argv[3],
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  }, null, 2)}\n`,
);
NODE
echo "[sites] npm ci が成功し、vinext を使用できます。"
