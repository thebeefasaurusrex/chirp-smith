# ChirpSmith

Generate repeatable sound effect variants, lint WAVs, and audition your favorites from a local browser board.

## Install

Install Node.js 22 and npm. Install FFmpeg for linting, loudness normalization, and the bundled example. Confirm it is available with `ffmpeg -version`. Set `GT_FFMPEG` to the executable path if it is outside your PATH.

```sh
git clone https://github.com/thebeefasaurusrex/chirp-smith.git
cd chirp-smith
npm ci --ignore-scripts
node bin/chirp-smith.mjs --help
```

## Make, check, and audition sounds

```sh
node bin/chirp-smith.mjs make examples/sounds.json
node bin/chirp-smith.mjs lint examples
node bin/chirp-smith.mjs board examples
```

Open the printed loopback URL in a browser. Mark each variant Keep or Redo, add a note, then press Ctrl+C in the terminal to stop the board. Choices are saved to `examples/choices.json`. On Windows, add `--open` to open the URL automatically.

The workbench keeps the waveform, 3D spectral terrain, and game picker visible above the scrolling take rack. Wide cards have full-width notes with four visible lines. Play a take to see its position sweep across the terrain, or use Show on scope to inspect it silently. Click, drag, or use the keyboard on the waveform to seek. The take rack keeps a running count of unreviewed, kept, and redo takes. Fonts and graphics are served locally. The terrain has a Canvas2D fallback when WebGL2 is unavailable, and the waveform works on its own when neither canvas renderer is available. Add `?fps` to the board URL to see the frame-rate readout.

### Open several games in one workbench

Create `boards.json` with the sound folders you want to review. Paths resolve relative to that file. Give every board a unique ID and its own sound folder.

```json
[
  { "id": "first-game", "folder": "first-game/sounds", "game": "First Game", "revision": "Build 12" },
  { "id": "second-game", "folder": "second-game/sounds", "game": "Second Game", "revision": "Build 3" }
]
```

```sh
node bin/chirp-smith.mjs board --library boards.json
```

Use the Sound board picker to switch games in the same browser tab. Each sound folder keeps its own `choices.json`. Notes finish saving before switching, and a failed save keeps you on the current board. Add `--select second-game` to choose the first board on launch. Each entry can also include a `task` label.

### Label an audition

Pass the game title, build or revision, and the source chat or task title when you have them.

```sh
node bin/chirp-smith.mjs make examples/sounds.json --game "Example Game" --revision "Build 12" --task "Impact sound audition"
node bin/chirp-smith.mjs board examples
```

The board and browser tab show the game and revision. The board also shows the source task when supplied. `make` stores these labels in `sounds.lock.json`. If omitted, the game name comes from the name in the nearest `gt.json`, the Git repository folder, or the audio folder. The default revision is the Git commit at generation time, if available. For imported WAVs or older sets, `board` accepts the same three flags for that launch. Each board shows a sound-set ID based on the WAV filenames and hashes, so you can tell sets apart even when they share a revision.

Labels are plain text in the lock file and on the local board. Leave `--task` out if the title is private and you plan to share the lock file.

`make` accepts a JSON file containing a `sounds` array. Each sound supplies an `id`, an `engine` (`jsfxr` or `zzfx`), a `preset` or `params`, a `seed`, the number of `variants`, and a `gain`. Add `target_lufs` to normalize with FFmpeg. The command writes 44.1 kHz mono PCM WAVs to `out/` beside the recipe and records their hashes in `sounds.lock.json`.

`lint` accepts a folder or a list of WAV paths. When you lint a folder with a lock file, ChirpSmith checks the recipe and WAV hashes before measuring. Add `--full` to see every result. The measurements cover loudness, true peak, clipping, duration, leading and trailing silence, and DC offset. JSON evidence and FFmpeg logs go under the target folder's `.gt/sfx/` directory and can include local paths.

Run `npm test` to verify reproducible WAV output, lint failures, audition choices across a board restart, and spectral analysis of stereo audio. See [third-party components](THIRD-PARTY.md) for package and font licenses.

## License

Original project code is licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
