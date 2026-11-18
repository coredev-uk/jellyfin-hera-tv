# Collection snapshots

Embedded data for Hera's curated collections. Each file is one definition:
`{ id, name, group, source, updated, items: [{ tmdb, type, title, year }] }`.
`type` is `movie` or `tv`. Every `tmdb` id was resolved through Seerr's TMDB
search (`/api/v1/search`) and only kept when the title matched exactly and the
release year was within one year (two for the Oscars, whose ceremony and release
years differ; three for one Soviet film, below).

Snapshot date for every file: **2026-11-18**.

| File | Items | Source |
| --- | --- | --- |
| `oscars-best-picture.json` | 98 | [Academy Award for Best Picture](https://en.wikipedia.org/wiki/Academy_Award_for_Best_Picture), winners 1927/28 to 2025 |
| `bafta-best-film.json` | 80 | [BAFTA Award for Best Film](https://en.wikipedia.org/wiki/BAFTA_Award_for_Best_Film), 1947 to 2025, including the 1961 tie |
| `bafta-outstanding-british.json` | 55 | [BAFTA Outstanding British Film](https://en.wikipedia.org/wiki/BAFTA_Award_for_Outstanding_British_Film) (Best British Film 1947 to 1967, 1992 onwards) |
| `mcu.json` | 55 | Marvel Cinematic Universe films and canon Disney+ series |
| `star-wars.json` | 27 | Films and series |
| `wizarding-world.json` | 11 | Harry Potter and Fantastic Beasts films |
| `middle-earth.json` | 8 | Lord of the Rings, The Hobbit, The War of the Rohirrim, The Rings of Power |
| `dc.json` | 22 | DCEU and DCU as **one** "DC" set; Elseworlds (Joker, The Batman) left out |
| `x-men.json` | 16 | Fox X-Men and Deadpool films, Legion, The Gifted, X-Men '97 |
| `fast-saga.json` | 12 | Fast & Furious films and Spy Racers |
| `conjuring.json` | 10 | The Conjuring Universe |
| `monsterverse.json` | 6 | Legendary's Godzilla and Kong films, Monarch |
| `star-trek.json` | 26 | Films and series |
| `christmas-classics.json` | 35 | Hand-picked, well-known Christmas films |
| `halloween-classics.json` | 37 | Hand-picked, well-known Halloween films |
| `bonfire-night.json` | 9 | Hand-picked: Gunpowder Plot, Tudor and Stuart drama, fire |

## Notes

- **Skipped on purpose:** Mission: Impossible, James Bond and Jurassic. TMDB has a
  collection for each, so the TMDb Box Sets plugin already makes those franchise
  BoxSets; Hera only groups them.
- **Deadpool & Wolverine** is in `mcu` only, not `x-men`.
- **Bonfire Night** is thin by nature (nine titles, not 25 to 40). Rely on the
  keyword rules for the rest rather than padding it with films that do not fit.
- **Unreleased at snapshot time or recently released** (TMDB had them, but check
  they are on a library before relying on them): The Mandalorian and Grogu,
  Supergirl, Clayface, Lanterns, Star Trek: Starfleet Academy.
- **Not included:** the 2025 Best Picture and 2025 BAFTA Best Film are both
  *One Battle After Another*, taken from Wikipedia at snapshot time. Avengers:
  Doomsday (December 2026) is omitted as unreleased.
- **Manually matched** (the automated title or year check failed, each checked by
  hand against TMDB):
  - `bafta-best-film`: *Ballad of a Soldier* (46592, released 1959, honoured 1961),
    *Dr. Strangelove or: How I Learned to Stop Worrying and Love the Bomb* (935),
    *The Queen* (1165, only on the second page of search results).
  - `mcu`: *The Fantastic 4: First Steps* (617126; TMDB's title differs).
  - `star-wars`: *The Acolyte* (114479; TMDB drops the "Star Wars:" prefix).
  - `fast-saga`: *Fast & Furious Presents: Hobbs & Shaw* (384018).
  - `star-trek`: the 1973 animated series is TMDB id 1992, titled just "Star Trek"
    there; the file renames it "Star Trek: The Animated Series".
- **Unresolved:** none. No entry was left out for lack of a match.
- V for Vendetta is dated 2006 by TMDB (UK release); the list originally gave 2005.

## Refreshing

1. Awards: re-read the Wikipedia page (or the official
   [BAFTA](https://www.bafta.org/) and [Oscars](https://www.oscars.org/) sites) and
   append the new winner after each ceremony.
2. Universes: append new films and series as they release.
3. For every addition, search Seerr:
   `GET https://seerr.hera.ac/api/v1/search?query=<title>` with the
   `X-Api-Key` header (key in the `jellyfin-secret` Kubernetes secret, key
   `HERATV_SEERR_API_KEY`; never commit it). Take the `id` where `mediaType`
   matches and title and year agree. Results are paged, so check `page=2` if the
   title is common.
4. Keep `type` as `movie` or `tv`, set `updated` to the month of the change, and
   check each file with `jq . <file>`.
