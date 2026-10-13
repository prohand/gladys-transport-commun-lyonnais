# Transports en Commun Lyonnais

Holen Sie den öffentlichen Nahverkehr von Lyon in Gladys: die nächsten
Abfahrten an den Haltestellen, die Sie nutzen, die Räder und freien Stellplätze
an Ihren Vélo'v-Stationen und die freien Plätze auf den P+R-Parkplätzen der TCL.

Jedes Gerät, das diese Integration erstellt, ist **schreibgeschützt**: Es
veröffentlicht, was die Open-Data-Feeds melden, und es wird nie etwas an das
Netz zurückgesendet.

## Was Sie erhalten

Ein Gerät pro Eintrag, den Sie in der Konfiguration angeben.

**Haltestelle** — für jede der nächsten Abfahrten (bis zu fünf, nach Wahl):

| Funktion            | Inhalt                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Next departure      | Wartezeit in Minuten (`999`, wenn nichts kommt)                                                  |
| Next departure line | `T1 → IUT Feyssine` (ein vorangestelltes `~` kennzeichnet eine Fahrplanschätzung statt Echtzeit) |
| Next departures     | Die ganze Abfahrtstafel in einer Zeile, für eine Dashboard-Kachel                                |

**Vélo'v-Station**

| Funktion                 | Inhalt                                                     |
| ------------------------ | ---------------------------------------------------------- |
| Bikes available          | Räder, die ausgeliehen werden können                       |
| Electric bikes available | Davon die E-Bikes, wenn der Feed sie ausweist              |
| Docks available          | Freie Stellplätze für die Rückgabe eines Rads              |
| Occupancy                | Anteil der Stellplätze, an denen ein Rad steht, in Prozent |
| Status                   | `OK`, `no bike available`, `Out of service`…               |

**P+R-Parkplatz (Park & Ride)**

| Funktion                    | Inhalt                                                 |
| --------------------------- | ------------------------------------------------------ |
| Spaces available            | Freie Autostellplätze, wo SYTRAL sie live zählt        |
| Accessible spaces available | Freie Behindertenparkplätze, sofern veröffentlicht     |
| Total capacity              | Plätze, die der Parkplatz laut Bestandsverzeichnis hat |
| Occupancy                   | Belegter Anteil der Kapazität, in Prozent              |
| Status                      | `120/655 free`, `Full`, `No live count (287 spaces)`…  |

Nicht jeder P+R-Parkplatz wird in Echtzeit gezählt: Der Belegungsdatensatz
deckt nur einen Teil des Netzes ab, der Rest wird als Bestandsverzeichnis ohne
Live-Zählung veröffentlicht. Diese Parkplätze lassen sich trotzdem überwachen —
sie veröffentlichen ihre Kapazität und den Status `No live count`, und die
freien Plätze erscheinen von selbst, sobald SYTRAL sie zu zählen beginnt.
`Spaces available`, `Accessible spaces available` und `Occupancy` bleiben dann
leer („Kein aktueller Wert“ in Gladys), und das ist die ehrliche Antwort: An der
Quelle wird für sie nichts veröffentlicht.

Der Status sagt, welche der beiden Situationen vorliegt:

- `No live count (287 spaces)` — der Parkplatz fehlt im Echtzeit-Datensatz.
  Nichts zu beheben, so veröffentlicht SYTRAL die offenen Daten;
- `Live count unreadable (287 spaces)` — der Parkplatz **ist** im
  Echtzeit-Datensatz, aber seine Zählung konnte nicht gelesen werden (eine
  umbenannte Spalte oder ein `-1`, das „unbekannt“ bedeutet). Bitte melden Sie
  es: Die empfangenen Spalten stehen in den Protokollen des Containers.

Die Schaltfläche **P+R-Parkplätze auflisten** zeigt dasselbe für das ganze
Netz, sodass Sie es erkennen können, ohne die Protokolle zu lesen.

## Konfiguration

### 1. Konto bei Data Grand Lyon (nur für Haltestellen und P+R-Parkplätze)

Vélo'v funktioniert ohne weitere Einrichtung: Sein Feed ist vollständig offen.

Die Abfahrten und die Belegung der P+R-Parkplätze stammen aus den
TCL-Echtzeitdatensätzen auf [data.grandlyon.com](https://data.grandlyon.com),
für die ein kostenloses Konto nötig ist.

> **Das hier verlangte Passwort ist nicht das, mit dem Sie sich anmelden.** Sie
> nutzen das Portal mit GrandLyon Connect (der gemeinsamen Anmeldung aller
> Dienste der Métropole de Lyon), der Webdienst, den diese Integration aufruft,
> akzeptiert jedoch nur ein eigenes Passwort der Datenplattform. Mit Ihrem
> GrandLyon-Connect-Passwort erhalten Sie „Data Grand Lyon hat die Zugangsdaten
> abgelehnt“.

1. Erstellen Sie ein Konto bei
   [GrandLyon Connect](https://moncompte.grandlyon.com/login/) oder melden Sie
   sich dort an.
2. Öffnen Sie
   [Ihr Profil auf der Datenplattform](https://data.grandlyon.com/onegeo-login/fr/profile/)
   und legen Sie das Passwort der Plattform fest. Es kann — und sollte — sich
   vom GrandLyon-Connect-Passwort unterscheiden.

   Dieses Formular heißt „Changer votre mot de passe“ und verlangt ein **altes
   Passwort**. Wenn Sie sich bisher nur über GrandLyon Connect angemeldet
   haben, besitzen Sie keines — und das GrandLyon-Connect-Passwort wird dort
   ebenfalls nicht akzeptiert. Melden Sie sich vom Portal ab: Die Profilseite
   führt dann zum eigenen Anmeldeformular der Datenplattform, wo der Link
   **Mot de passe oublié ?** (Passwort vergessen) Ihnen per E-Mail einen Link
   schickt, mit dem Sie das Passwort festlegen, ohne das vorherige zu kennen.
   Das so festgelegte Passwort ist das, das Sie in die Integration eintragen.

3. Geben Sie in der Konfiguration der Integration den **Benutzernamen** (in der
   Regel die E-Mail-Adresse Ihres Kontos) und dieses **Passwort der
   Plattform** ein.
4. Drücken Sie **Konto bei Data Grand Lyon testen** — es meldet, wie viele
   P+R-Parkplätze es lesen konnte.

Lassen Sie beide Felder leer, wenn Sie nur Vélo'v-Stationen überwachen.

### 2. Der Integration sagen, was überwacht werden soll

Die drei Listenfelder akzeptieren Einträge, die durch Kommas, Semikolons oder
Zeilenumbrüche getrennt sind. Sie müssen die Kennungen nicht auf einer Website
suchen: Die Schaltflächen unten auf der Seite „Konfiguration“ suchen sie für
Sie.

**Haltestellen** — `<Haltestellen-ID>[@<Linie>[|<Linie>…]][:<eigener Name>]`

| Eintrag                 | Bedeutung                                   |
| ----------------------- | ------------------------------------------- |
| `1234`                  | Alle Abfahrten an der Haltestelle 1234      |
| `1234@T1`               | Nur die Linie T1                            |
| `1234@C3\|C13`          | Die Linien C3 und C13                       |
| `1234@T1:Tram zu Hause` | Nur T1, und das Gerät heißt „Tram zu Hause“ |

Wenn Sie dieselbe Haltestelle zweimal mit zwei verschiedenen Linienfiltern
überwachen, erhalten Sie zwei Geräte — eines pro Linie, was auf einem
Dashboard meist genau das Richtige ist.

Drücken Sie **Haltestelle suchen** und geben Sie einen Namen ein (zum Beispiel
`Bellecour`), um die einzufügenden Kennungen zu erhalten. Jedes Ergebnis sagt
auch, wohin seine Linien fahren:

```
1234 — Bellecour (A → Perrache, A → Vaulx-en-Velin La Soie)
5678 — Bellecour (C3 → Gare Saint-Paul)
```

Genau danach müssen Sie wählen: Das Netz vergibt den beiden Straßenseiten
unter einem Namen zwei verschiedene Kennungen, und die Endhaltestelle — die
vorne an der Tram steht — verrät, welcher Bahnsteig in Ihre Richtung fährt.
Die Richtungen stammen aus den gerade angekündigten Abfahrten; eine Haltestelle,
an der nichts fährt, erscheint daher nur mit ihren Linien. Suchen Sie sie
während der Betriebszeiten erneut, um die Richtungen zu sehen.

**Vélo'v-Stationen** — `<Stations-ID oder Name>[:<eigener Name>]`

`10063`, `Hotel de Ville` oder `10063:Arbeit`. Drücken Sie **Vélo'v-Station
suchen**, um nach Namen zu suchen.

**P+R-Parkplätze** — `<P+R-ID oder Name>[:<eigener Name>]`

`Gorge de Loup`, `SOI` oder `Parilly:Pendeln`. Die Kennungen sind kurze Codes
in Großbuchstaben (`SOI`, `BON`, `GREY`…), der Name funktioniert genauso gut.
Drücken Sie **P+R-Parkplätze auflisten**, um alle Parkplätze mit ihrer Kennung
und ihrer aktuellen Belegung zu sehen — alle 22, auch die, die SYTRAL nicht in
Echtzeit zählt; diese erscheinen mit `?` freien Plätzen. Auch sie ergeben ein
brauchbares Gerät: Ihre Kapazität wird veröffentlicht, die Zahl der freien
Plätze nicht.

### 3. Aktualisierungsintervalle

Jede Datenquelle hat ihr eigenes Intervall, weil sie sich nicht gleich schnell
ändern:

| Einstellung                   | Standard | Was sie steuert                                 |
| ----------------------------- | -------- | ----------------------------------------------- |
| Aktualisierung der Abfahrten  | 60 s     | Die Countdowns an jeder überwachten Haltestelle |
| Aktualisierung Vélo'v         | 120 s    | Verfügbarkeit von Rädern und Stellplätzen       |
| Aktualisierung P+R-Parkplätze | 300 s    | Freie Plätze auf jedem überwachten Parkplatz    |

Alle drei akzeptieren 30 s bis 3600 s. Unter 60 s zu gehen bringt nichts: Die
Quell-Feeds werden selbst nur etwa einmal pro Minute neu berechnet, ein
schnelleres Abfragen liefert also dieselben Zahlen und verbraucht dabei Ihr
Kontingent bei Data Grand Lyon. Gladys selbst taktet nie langsamer als einmal
pro Minute; ein Intervall über 60 s setzt die Integration um, indem sie die
Takte dazwischen einfach überspringt.

Die Integration bündelt außerdem ihre Anfragen: Zehn überwachte
Vélo'v-Stationen kosten zwei HTTP-Anfragen pro Zyklus, nicht zwanzig, und fünf
P+R-Parkplätze kosten zwei. Ein fehlgeschlagener Lesevorgang (Zeitüberschreitung
der Plattform, Netzwerkausfall) wird eine Minute später wiederholt, nicht erst
nach dem ganzen Intervall.

**Was gespeichert wird.** Ein kurzes Aktualisierungsintervall ergibt eine
schnell wachsende Datenbank, wenn jeder Messwert notiert wird. Deshalb sendet
die Integration Gladys nur die Werte, die sich seit dem letzten Lesen
tatsächlich geändert haben: Ein Parkplatz, dessen freie Plätze sich die ganze
Nacht nicht bewegen, wird einmal gespeichert, nicht dreihundertmal. Die
Countdowns der Abfahrten gehen noch einen Schritt weiter und behalten überhaupt
keinen Verlauf — „7 Minuten, dann 6, dann 5, dann wieder 12“ ist die Form jedes
Fahrplans, und niemand liest sie zurück, obwohl sie von den dreien mit Abstand
am meisten schreiben würden. Auf Ihrem Dashboard sind sie trotzdem live; nur
ihre Vergangenheit wird nicht aufbewahrt. Die Vélo'v-Verfügbarkeit und die
Belegung der P+R-Parkplätze behalten ihren Verlauf: Diese Diagramme haben einen
Wert, und ein Punkt pro Änderung zeichnet dieselbe Kurve wie ein Punkt pro
Abfrage.

### 4. Speichern

Speichern Sie die Konfiguration und öffnen Sie dann den Reiter **Entdecken**:
Ihre Haltestellen, Stationen und Parkplätze stehen dort bereit, um zu Gladys
hinzugefügt zu werden.

## Dashboard-Widgets und Szenen

Seit Gladys 5.1 bringt die Integration auch eigene Dashboard-Widgets sowie
eigene Szenen-Auslöser und -Aktionen mit. Sie arbeiten mit den Geräten, die Sie
erstellt haben: Fügen Sie zuerst die Haltestellen, Stationen und Parkplätze im
Reiter **Entdecken** hinzu und wählen Sie dann eines davon in der Widget- oder
Szenenkarte.

### Widgets

Im Dashboard-Editor stehen die Widgets unter dem Namen der Integration.

| Widget            | Was es zeigt                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| TCL-Abfahrten     | Die Abfahrtstafel einer Haltestelle: die nächste Abfahrt als große Kachel, dann bis zu acht Abfahrten, die nächste zuerst |
| Vélo'v-Station    | Räder, E-Bikes und freie Stellplätze, die Füllstandsanzeige, die Kurve der letzten 24 Stunden und der Zustand der Station |
| TCL-P+R-Parkplatz | Freie Plätze, Kapazität, Behindertenplätze, die Füllstandsanzeige, die Kurve der letzten 24 Stunden und der Zustand       |

Auf der Tafel steht ein grüner Punkt für eine in Echtzeit verfolgte Abfahrt
und ein grauer Punkt (mit vorangestelltem `~`) für eine Fahrplanschätzung. Ein
Widget, das mit einem Gerät der falschen Art eingerichtet wurde — eine
Vélo'v-Station im Abfahrten-Widget —, sagt das, statt leer zu bleiben.

Ein Widget zeigt den letzten Messwert des Geräts, solange dieser frischer ist
als die Karte selbst (30 s für Abfahrten, 60 s für Vélo'v, 120 s für
P+R-Parkplätze), und die Widgets, die im selben Moment geöffnet werden, teilen
sich einen Lesevorgang: Ein Dashboard, das auf mehreren Bildschirmen offen
bleibt, vervielfacht nicht die Anfragen an Data Grand Lyon.

### Szenen-Auslöser

Im Szenen-Editor unter **Integrationen**:

| Auslöser                      | Wird ausgelöst, wenn                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| TCL-Abfahrt steht bevor       | Die nächste Abfahrt einer Linie die gewählte Marke unterschreitet: 1, 2, 3, 5, 10 oder 15 Minuten. Optionaler Linienfilter (`T1`)                  |
| Vélo'v-Verfügbarkeit geändert | Das letzte Rad ausgeliehen wird, wieder Räder da sind, der letzte Stellplatz belegt wird, Stellplätze frei werden, die Station außer Betrieb geht… |
| P+R-Verfügbarkeit             | Der Parkplatz zu über 90 % belegt ist, voll wird oder wieder Plätze frei hat                                                                       |

Die folgenden Schritte der Szene können die Details des Ereignisses lesen: die
Linie, ihre Richtung und die Wartezeit in Minuten; die verbleibenden Räder und
Stellplätze; die freien Plätze und den Füllstand.

Gut zu wissen:

- Die Auslöser vergleichen zwei aufeinanderfolgende Lesevorgänge des Geräts und
  folgen daher seinem Aktualisierungsintervall: Ein P+R-Parkplatz, der alle
  5 Minuten gelesen wird, kann nicht früher auslösen;
- beim ersten Lesen nach dem Start der Integration wird nichts ausgelöst: Es
  gibt noch kein „Vorher“, mit dem verglichen werden könnte;
- die Linie des Abfahrts-Auslösers wird so verglichen, wie sie auf dem Fahrzeug
  steht, Großschreibung inbegriffen (`T1`, `C3`).

### Szenen-Aktionen

| Aktion                  | Liefert den folgenden Schritten                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Nächste Abfahrten lesen | Die nächste Abfahrt (Linie, Richtung, Minuten, Echtzeit oder nicht), die darauf folgende, eine einzeilige Tafel |
| Vélo'v-Station lesen    | Räder, E-Bikes, freie Stellplätze, Füllstand und Zustand                                                        |
| P+R-Parkplatz lesen     | Freie Plätze, Kapazität, Füllstand und Zustand                                                                  |

Die Aktionen lesen den Feed in dem Moment, in dem die Szene läuft, nicht den
Wert, den das Gerät zuletzt erhalten hat: „Schick mir um 7:40 die nächste T1
in Bellecour“ liefert den Countdown von 7:40.

## Ideen für Automatisierungen

- Werktags um 8:00 **Nächste Abfahrten lesen** an meiner Haltestelle und mir
  die Tafel schicken.
- Wenn die nächste T1 in Bellecour noch **5 Minuten** entfernt ist, mir eine
  Benachrichtigung schicken: Zeit zu gehen.
- Wenn die Vélo'v-Station bei der Arbeit **keinen freien Stellplatz mehr** hat,
  mich warnen, bevor ich losfahre.
- Wenn mein üblicher P+R-Parkplatz zu über **90 % belegt** ist, mich daran
  erinnern, stattdessen die Tram zu nehmen.

## Fehlerbehebung

**„Haltestellen und P+R-Parkplätze erfordern ein Konto bei Data Grand Lyon“** —
der Status der Integration bleibt rot, weil Sie eine Haltestelle oder einen
Parkplatz angegeben haben, ohne die Zugangsdaten auszufüllen. Tragen Sie sie
ein oder entfernen Sie die Einträge.

**Die Profilseite verlangt ein altes Passwort, das ich nie festgelegt habe** —
dieses Formular _ändert_ ein bestehendes Passwort, und ein über GrandLyon
Connect erstelltes Konto hat keines. Melden Sie sich vom Portal ab, öffnen Sie
erneut
[data.grandlyon.com/onegeo-login/fr/profile/](https://data.grandlyon.com/onegeo-login/fr/profile/)
— Sie landen auf dem Anmeldeformular der Datenplattform — und nutzen Sie
**Mot de passe oublié ?** mit der E-Mail-Adresse des Kontos. Der per E-Mail
geschickte Link legt das Passwort der Plattform fest, ohne dass ein altes
Passwort nötig ist.

**„Data Grand Lyon hat die Zugangsdaten abgelehnt“** — in neun von zehn Fällen
ist das eingegebene Passwort das von GrandLyon Connect. Der Webdienst will das
Passwort, das Sie auf
[data.grandlyon.com/onegeo-login/fr/profile/](https://data.grandlyon.com/onegeo-login/fr/profile/)
festlegen, mit der E-Mail-Adresse Ihres Kontos als Benutzernamen. Legen Sie es
dort fest, tragen Sie es hier ein und drücken Sie **Konto bei Data Grand Lyon
testen**. Schlägt es weiterhin fehl, hat das Konto seine E-Mail-Adresse
möglicherweise noch nicht bestätigt.

**„Data Grand Lyon hat mit HTTP 404 geantwortet“** — Ihr Konto ist in Ordnung:
Der Datensatz selbst wird nicht unter dem Namen veröffentlicht, den die
Integration angefragt hat. Die Métropole benennt ihre TCL-Ebenen um, wenn sich
das Netz ändert (dafür steht das Suffix `_2_0_0` in der Meldung). Die
Integration probiert jeden Namen, den sie kennt, fragt dann den Katalog der
Plattform, wie der Datensatz heute heißt, und verwendet diesen Namen; die
meisten Umbenennungen heilen sich so ohne Update von selbst. Wenn selbst der
Katalog nichts hat, listet die Meldung auf, was versucht wurde, und die
ähnlichsten Namen, die die Plattform veröffentlicht: Eröffnen Sie damit ein
Issue, dann genügt ein Update der Integration.

**„Konto bei Data Grand Lyon testen“ meldet einen Datensatz als nicht lesbar** —
die Schaltfläche prüft die drei Datensätze einzeln, und ihre erste Zeile ist
die entscheidende: Wenn sie sagt, dass Ihr Konto akzeptiert wurde, stimmen Ihre
Zugangsdaten. Eine einzelne `✖`-Zeile bedeutet, dass dieser eine Datensatz
eingestellt wurde (siehe oben); die Funktionen, die auf den beiden anderen
beruhen, funktionieren weiter.

**„Data Grand Lyon hat … nicht innerhalb von … geantwortet“** — die Plattform hat
zu lange gebraucht, meist beim Herunterladen des ganzen
Haltestellenverzeichnisses für **Haltestelle suchen**. Drücken Sie die
Schaltfläche erneut: Der erste erfolgreiche Download bleibt eine Stunde im
Speicher, die folgenden Suchen antworten sofort. Wenn Sie den Namen einer
Haltestelle vollständig eingeben (`Bellecour` statt `belle`), entfällt der
Download ganz.

**Eine Haltestelle zeigt immer `999`** — `999` bedeutet „keine Abfahrt
angekündigt“. Außerhalb der Betriebszeiten ist das normal. Bleibt es tagsüber
so, ist die Haltestellen-ID wahrscheinlich falsch (oder der Linienfilter passt
nie, z. B. `@T1` an einer reinen Bushaltestelle): Führen Sie **Haltestelle
suchen** erneut aus.

**Eine Vélo'v-Station oder ein P+R-Parkplatz meldet bei jeder Abfrage einen
Fehler** — die Kennung ist nicht im Feed. Führen Sie die passende
Suchschaltfläche erneut aus und tragen Sie die zurückgegebene ID ein; der
Fehler eines P+R-Parkplatzes nennt außerdem einige der Kennungen, die der
Datensatz enthält.

**Ein P+R-Parkplatz zeigt einen Status und eine Kapazität, aber keine freien
Plätze** — SYTRAL zählt diesen Parkplatz nicht live, und die Integration
erfindet keine Zahl: **P+R-Parkplätze auflisten** zeigt daneben dasselbe `?`.
Das sind die offenen Daten, nicht die Konfiguration.

**Ein Gerät zeichnet seit dem Update der Integration nichts mehr auf** — Gladys
behält die Funktionen, mit denen ein Gerät erstellt wurde, und ein Container
kann einem bereits bestehenden Gerät keine hinzufügen: Eine erneute
Veröffentlichung der Erkennung aktualisiert nur seine Parameter. Eine Version,
die eine Funktion hinzufügt, veröffentlicht also Werte, die nirgends landen
können. Ein P+R-Parkplatz, den niemand live zählt, ist der deutlichste Fall:
Seine einzigen zwei Werte, `Total capacity` und `Status`, sind genau die
Funktionen, die einem älteren Gerät fehlen, und der Parkplatz bleibt leer,
während die Protokolle nur den dünnen Feed erwähnen. Die Integration sagt das
jetzt: Das Gerät trägt in der Geräteliste einen orangefarbenen Punkt, dessen
Tooltip nennt, was fehlt, und die Protokolle schreiben es einmal aus
(`… does not have the feature(s) capacity, status in Gladys …`). Die Lösung
liegt im Reiter **Entdecken**: Drücken Sie beim Gerät auf **Aktualisieren**
(es zu löschen und erneut hinzuzufügen funktioniert auch), und das Gerät wird
sofort neu gelesen.

**Ein Gerät, das ich hinzugefügt habe, bleibt leer** — Funktionen ganz ohne
Wert bedeuten, dass das Gerät nie gelesen wird. Ältere Versionen
veröffentlichten ihre Geräte ohne das Kennzeichen, das Gladys zur Planung der
Abfragen liest; der Kern fragte sie daher nie ab, und nirgends wurde ein Fehler
gemeldet. Die Integration aktualisiert ihre Geräte jetzt auch selbst, sodass
sich ein leeres Gerät kurz nach dem Neustart des Containers füllt, ohne
gelöscht und erneut hinzugefügt werden zu müssen. Ist es danach immer noch
leer, schlägt der Lesevorgang selbst fehl: Die Integration protokolliert jeden
fehlgeschlagenen Lesevorgang mit seinem Grund.

**Ich habe eine Kennung eingefügt und der Reiter „Entdecken“ bleibt leer** —
der Reiter „Entdecken“ listet nur, was die Integration veröffentlicht hat, und
sie veröffentlicht, wenn die Konfiguration _gespeichert_ wird, nicht beim
Bearbeiten eines Feldes. Speichern Sie die Konfiguration und lesen Sie dann
den Status der Integration direkt darüber: Er nennt jetzt, was überwacht wird
(„Verbunden. Überwacht 1 Haltestelle — sie erscheinen im Reiter „Entdecken“.“).
Steht dort etwas anderes oder fehlt Ihr Eintrag in der Zählung, ist der Wert
nicht bei der Integration angekommen — prüfen Sie, ob das Feld gespeichert
wurde, und drücken Sie dann die Schaltfläche **Scannen** im Reiter
„Entdecken“. Die Integration protokolliert dasselbe bei jeder
Veröffentlichung: `Publishing 1 device(s): Bellecour`.

Die Integration protokolliert alles, was sie tut: Lesen Sie die
**Protokolle** der Integration in der Gladys-Oberfläche, mit `LOG_LEVEL=debug`
für alle Details (jede ausgehende Anfrage wird auf dieser Stufe
protokolliert).

## Datenquellen und Nachweise

- [TCL-Echtzeitabfahrten](https://data.grandlyon.com/portail/fr/jeux-de-donnees/prochains-passages-reseau-transports-commun-lyonnais-rhonexpress-disponibilites-temps-reel/info)
  — Métropole de Lyon / SYTRAL, auf Data Grand Lyon.
- [Verfügbarkeit der TCL-P+R-Parkplätze](https://data.grandlyon.com/portail/fr/jeux-de-donnees/parcs-relais-reseau-transports-commun-lyonnais-disponibilites-temps-reel/info)
  — Métropole de Lyon / SYTRAL, auf Data Grand Lyon.
- [Vélo'v-Verfügbarkeit](https://transport.data.gouv.fr/datasets/velos-libre-service-lyon-velov-disponibilite-en-temps-reel)
  — Métropole de Lyon / JCDecaux, veröffentlicht als
  [GBFS](https://gbfs.org/documentation/reference/)-Feed.

Dies ist eine inoffizielle Integration. Sie steht in keiner Verbindung zu
SYTRAL Mobilités, Keolis Lyon oder JCDecaux.
