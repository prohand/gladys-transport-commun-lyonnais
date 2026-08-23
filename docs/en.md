# Transports en Commun Lyonnais

Bring Lyon's public transport network into Gladys: the next departures at the
stops you use, the bikes and free docks at your Vélo'v stations, and the free
spaces in the TCL park & ride car parks.

Every device this integration creates is **read-only**: it publishes what the
open data feeds say, and nothing is ever sent back to the network.

## What you get

One device per entry you list in the configuration.

**Transit stop** — for each of the next departures (up to five, your choice):

| Feature             | What it holds                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Next departure      | Minutes to wait (`999` when nothing is coming)                                            |
| Next departure line | `T1 → IUT Feyssine` (a `~` prefix marks a timetable estimate rather than a real-time one) |
| Next departures     | The whole board on one line, for a dashboard tile                                         |

**Vélo'v station**

| Feature                  | What it holds                                     |
| ------------------------ | ------------------------------------------------- |
| Bikes available          | Bikes ready to rent                               |
| Electric bikes available | Subset that is electric, when the feed details it |
| Docks available          | Free stands to return a bike                      |
| Occupancy                | Share of the stands holding a bike, in percent    |
| Status                   | `OK`, `no bike available`, `Out of service`…      |

**Park & ride (P+R)**

| Feature                     | What it holds                                             |
| --------------------------- | --------------------------------------------------------- |
| Spaces available            | Free car spaces                                           |
| Accessible spaces available | Free spaces reserved for reduced mobility, when published |
| Occupancy                   | Share of the capacity taken, in percent                   |

## Configuration

### 1. Data Grand Lyon account (transit stops and park & ride only)

Vélo'v works out of the box: its feed is fully open.

Transit departures and park & ride occupancy come from the TCL real-time
datasets hosted on [data.grandlyon.com](https://data.grandlyon.com), which
require a free account:

1. Create an account on data.grandlyon.com.
2. Paste the username and the password in the integration configuration.
3. Press **Test the Data Grand Lyon account** — it reports how many park & ride
   facilities it could read.

Leave both fields empty if you only watch Vélo'v stations.

### 2. Tell the integration what to watch

The three list fields accept entries separated by commas, semicolons or
newlines. You do not need to hunt for identifiers on a website: the buttons at
the bottom of the Configuration screen search them for you.

**Transit stops** — `<stop id>[@<line>[|<line>…]][:<custom name>]`

| Entry                  | Meaning                                     |
| ---------------------- | ------------------------------------------- |
| `1234`                 | Every departure at stop 1234                |
| `1234@T1`              | Only line T1                                |
| `1234@C3\|C13`         | Lines C3 and C13                            |
| `1234@T1:Tram at home` | Only T1, and name the device "Tram at home" |

Watching the same stop twice with two different line filters gives you two
devices — one per line, which is usually what you want on a dashboard.

Press **Find a transit stop** and type a name (for example `Bellecour`) to get
the identifiers to paste.

**Vélo'v stations** — `<station id or name>[:<custom name>]`

`10063`, `Hotel de Ville`, or `10063:Work`. Press **Find a Vélo'v station** to
search by name.

**Park & ride** — `<P+R id or name>[:<custom name>]`

`Gorge de Loup`, or `Parilly:Commute`. Press **List the park & ride
facilities** to see every facility with its identifier and current occupancy.

### 3. Refresh intervals

Each data source has its own interval, because they do not move at the same
speed:

| Setting                      | Default | What it drives                       |
| ---------------------------- | ------- | ------------------------------------ |
| Departures refresh interval  | 60 s    | The countdowns at each watched stop  |
| Vélo'v refresh interval      | 120 s   | Bike and dock availability           |
| Park & ride refresh interval | 300 s   | Free spaces in each watched car park |

All three accept 30 s to 3600 s. Going below 60 s buys you nothing: the
upstream feeds are themselves recomputed about once a minute, so a faster poll
returns the same numbers while consuming your Data Grand Lyon quota.

The integration also batches its requests: watching ten Vélo'v stations costs
two HTTP requests per cycle, not twenty, and watching five park & ride
facilities costs one.

### 4. Save

Save the configuration, then open the **Discovery** tab: your stops, stations
and car parks are there, ready to be added to Gladys.

## Ideas for automations

- Notify me at 8:00 on weekdays with the next departures at my stop.
- If the Vélo'v station near work has fewer than 3 free docks when I leave,
  send me a warning.
- If my usual park & ride is more than 90% full at 7:30, remind me to take the
  tram instead.

## Troubleshooting

**"Transit stops and park & ride need a Data Grand Lyon account"** — the
integration status stays red because you listed a stop or a car park without
filling in the credentials. Add them, or remove the entries.

**"Data Grand Lyon refused the credentials"** — the username or the password is
wrong, or the account has not confirmed its email yet. Check with **Test the
Data Grand Lyon account**.

**A stop always shows `999`** — `999` means "no departure announced". Outside
service hours that is normal. If it persists during the day, the stop id is
probably wrong (or the line filter never matches, e.g. `@T1` on a bus-only
stop): re-run **Find a transit stop**.

**A Vélo'v station or a park & ride errors on every poll** — the identifier is
not in the feed. Re-run the matching search button and paste the id it returns.

The integration logs everything it does: read the integration logs from the
Gladys UI, with `LOG_LEVEL=debug` for the full detail (every outgoing request
is logged at that level).

## Data sources and credits

- [TCL real-time departures](https://data.grandlyon.com/portail/fr/jeux-de-donnees/prochains-passages-reseau-transports-commun-lyonnais-rhonexpress-disponibilites-temps-reel/info)
  — Métropole de Lyon / SYTRAL, on Data Grand Lyon.
- [TCL park & ride availability](https://data.grandlyon.com/portail/fr/jeux-de-donnees/parcs-relais-reseau-transports-commun-lyonnais-disponibilites-temps-reel/info)
  — Métropole de Lyon / SYTRAL, on Data Grand Lyon.
- [Vélo'v availability](https://transport.data.gouv.fr/datasets/velos-libre-service-lyon-velov-disponibilite-en-temps-reel)
  — Métropole de Lyon / JCDecaux, published as a
  [GBFS](https://gbfs.org/documentation/reference/) feed.

This is an unofficial integration. It is not affiliated with SYTRAL Mobilités,
Keolis Lyon or JCDecaux.
