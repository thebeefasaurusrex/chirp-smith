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

`make` accepts a JSON file containing a `sounds` array. Each sound supplies an `id`, an `engine` (`jsfxr` or `zzfx`), a `preset` or `params`, a `seed`, the number of `variants`, and a `gain`. Add `target_lufs` to normalize with FFmpeg. The command writes 44.1 kHz mono PCM WAVs to `out/` beside the recipe and records their hashes in `sounds.lock.json`.

`lint` accepts a folder or a list of WAV paths. When you lint a folder with a lock file, ChirpSmith checks the recipe and WAV hashes before measuring. Add `--full` to see every result. The measurements cover loudness, true peak, clipping, duration, leading and trailing silence, and DC offset. JSON evidence and FFmpeg logs go under the target folder's `.gt/sfx/` directory and can include local paths.

Run `npm test` to verify reproducible WAV output, lint failures, and audition choices across a board restart. See [third-party components](THIRD-PARTY.md) for dependency licenses.

## License

Original project code is licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
