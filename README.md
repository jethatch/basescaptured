# Bases Captured

**Every plate appearance leaves bases on the table. Who takes the most of them?**

A just-for-fun MLB stat and an off-season page to play with, covering 1975–2025.

Live page: https://jethatch.github.io/basescaptured/

## The stat

Every plate appearance starts with bases up for grabs:

- **4** for the batter, all the way home.
- For each runner, the bases he still needs to score: **3** from first, **2** from second, **1** from third.

Bases Captured is how many of those the play actually took, credited to the batter.

| Play | Captured |
|---|---|
| Solo home run | 4 of 4 |
| Grand slam | 10 of 10 |
| Runner on first, a single sends him to third | 3 of 7 |
| Bases-loaded strikeout | 0 of 10 |

The rules for the unusual cases:

- **Only the final play counts.** Steals, wild pitches and pickoffs before it don't count. Runners count from where they stand when the last pitch is thrown. A steal or wild pitch on the last pitch itself is left out too, except for a forced advance on a walk.
- **A runner put out keeps the bases he reached safely first.** Runners who advance on an out (sacrifice flies, productive groundouts) count. The stat never goes below zero.
- **Every plate appearance counts:** walks, hit-by-pitches and sacrifices included. Regular season only.
- **Some bases count but are tracked:** bases taken on errors, dropped third strikes and catcher's interference count, and the page reports them.

### Measures on the page

- **Bases captured:** total captured ÷ total possible over a season.
- **Captured+:** bases captured against what an average hitter took that season in the same base-out situations (the same runners on and the same number of outs). 100 is average. There is no park adjustment.
- **His own bases and Runners' bases:** the two parts of the total.
- **Per plate appearance:** the average of each plate appearance's own ratio. It appears in the player panel.
- **Comparison stats:** AVG, OBP, SLG, OPS, OPS+ (league-relative, with no park adjustment, so it won't match published OPS+ exactly), HR, RBI and RE24 (centred so the league is 0). All are worked out from the same play-by-play.
- **Bases lost:** the bases runners had reached before being put out on his plays, plus double plays. These are shown alongside the stat, not counted in it.

**Qualified hitters** have 3.1 plate appearances per team game.

This is a toy, not a serious stat. It ignores the pitcher, the park, the score and plenty more.

## Data and credits

- **Play-by-play:** [Retrosheet](https://www.retrosheet.org/) parsed play-by-play files.

  > The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at 20 Sunset Rd., Newark, DE 19711.

- **Player IDs:** the [Chadwick Baseball Bureau register](https://github.com/chadwickbureau/register) (Open Data Commons Attribution License). It is used to match Retrosheet IDs to MLB IDs.
- **Headshots:** loaded in the browser from MLB's image server. They belong to MLB and are not stored in this repository.

This project is not affiliated with or endorsed by Major League Baseball or any team.

## How it's built

`docs/` is the whole site: static HTML, CSS and JavaScript with no build step. GitHub Pages serves it from the `docs/` folder on `main`.

`pipeline/build.py` makes everything in `docs/data/` from Retrosheet. It uses only the Python standard library.

```bash
python3 -I pipeline/build.py --start 1975 --end 2025   # download, score every plate appearance, write season files
python3 -I pipeline/build.py --index-only              # rebuild index, careers and all-time lists only
```

Raw downloads are cached in `data/raw/` and per-plate-appearance files in `data/interim/`. Both are gitignored. A full rebuild takes about five minutes once the downloads are cached.

To preview locally:

```bash
python3 -m http.server 8765 --directory docs
```

`pipeline/og/preview.html` is the source of the link-preview image `docs/img/preview.png`. The command to render it is in the file.

## License

The code is under the MIT License (see `LICENSE`). The data in `docs/data/` comes from Retrosheet and the Chadwick Bureau, under their own terms above.
