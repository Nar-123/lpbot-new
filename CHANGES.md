# Cara apply patch ini

1. Extract isi zip ini **langsung di root folder project** Anda (folder yang
   ada `package.json`, `src/`, `test/` di dalamnya) — timpa file yang sudah
   ada, tambahkan file yang baru. Semua path di dalam zip sudah relatif ke
   root project (`src/agent/config.ts`, `test/agent.loop.test.ts`, dst).

2. Install dependency baru:
   ```bash
   npm install
   ```
   (menambahkan `@anthropic-ai/sdk` — sudah ada di `package.json`/`package-lock.json`
   yang di-overwrite oleh patch ini)

3. Verifikasi — WAJIB jalankan sebelum percaya apa pun:
   ```bash
   npx tsc --noEmit
   npx tsx --test test/*.test.ts
   ```
   Yang saya dapat di sandbox saya sendiri: **typecheck bersih, 762 test
   total, 761 pass, 1 skip (test jaringan), 0 fail.** Angka Anda harus
   persis sama (mungkin beda dikit di durasi, bukan di hasil).

4. Fitur baru semuanya **default OFF / tidak mengubah perilaku existing**
   kecuali Anda set env var-nya (lihat `.env.example` yang sudah di-update,
   cari bagian `AGENT_*`, `EXIT_*`, `MULTI_RANGE_*`, `MULTI_SELF_TUNE_WEIGHTS`).

## Daftar 27 file yang berubah

**File baru (12):**
- `src/agent/{types,config,tools,llmClient,loop,lessons,scheduler}.ts` — agen LLM otonom + lessons + scheduler
- `src/strategy/exitRules.ts` — mesin 7 aturan exit
- `src/strategy/signalWeights.ts` — self-tuning bobot sinyal
- `test/agent.{loop,tools,lessons,scheduler}.test.ts`
- `test/strategy.{exitRules,signalWeights}.test.ts`
- `test/strategy.multiConfig.rangePreset.test.ts`
- `test/tpslWatcher.{exitRules,signalWeights}.test.ts`

**File diubah (9):**
- `src/bot/bot.ts` — command `/agent`, wiring recalc bobot + lesson di manual `/close`
- `src/bot/tpslWatcher.ts` — mesin exit 7-aturan menggantikan `classify()` lama, wiring recalc bobot + lesson
- `src/db/index.ts` — state exit engine, entry-signal snapshot, tuned weights, lessons storage
- `src/index.ts` — startup `AGENT_MODE` validation + scheduler start/stop
- `src/strategy/multiConfig.ts` — range preset (tight/normal/wide), self-tuning weight override
- `src/strategy/multiExecute.ts` — refactor `evaluateAndExecuteCandidate` (dipakai bareng oleh agent tool)
- `.env.example`, `package.json`, `package-lock.json`

## Fitur yang MASIH BELUM ada (jujur, dari diskusi kita)

- `get_wallet_balance` tool belum di-DI (masih hit RPC asli, bukan bug, cuma belum optimal buat test)
- Adaptive repeat-deploy cooldown (belum dikerjakan)
- Overextended exit RSI/Bollinger (belum dikerjakan — butuh infrastruktur candle baru)
- HiveMind, DLMM liquidity shapes, partial fee claim — sengaja tidak diport (lihat diskusi sebelumnya kenapa)

## Sebelum live

- Jalankan dulu di `TRADING_MODE=staging`
- `AGENT_MODE=on` tanpa `AGENT_AUTONOMOUS_SCHEDULE=on` = `/agent` cuma bisa dipicu manual dari Telegram (rekomendasi awal)
- `AGENT_AUTONOMOUS_SCHEDULE=on` = agent jalan sendiri terjadwal — ini lompatan otonomi yang lebih besar, coba manual dulu sebelum ke mode ini
