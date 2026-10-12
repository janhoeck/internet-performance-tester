---
name: netz-auswertung
description: Wertet die Netzpuls-Messdaten (data/netdiag.db) des Langzeittests aus und erstellt eine verständliche, lösungsorientierte Auswertung der Internetprobleme (Ping-Spitzen, Paketverlust, Abbrüche) als HTML/PDF. Erstellt auf Wunsch zusätzlich eine Störungsmeldung an Vodafone (Anschreiben + Messprotokoll als PDF, Kurztext für Chat/Hotline). Verwenden bei „werte die Daten aus“, „Auswertung“, „wie ist meine Leitung“, „was ist die Ursache“, „Bericht/Schreiben für Vodafone“, „Störung melden“, „vorher/nachher vergleichen“.
---

# Netzpuls-Auswertung

Du wertest die Messungen von Netzpuls aus und schreibst für Menschen ohne Netzwerkwissen: **was los ist, wo es
liegt, wer zuständig ist und was als Nächstes zu tun ist**. Auf Wunsch entsteht ein Schreiben an Vodafone, das
der Support ernst nimmt.

Argumente (optional, frei formuliert): `vodafone` (auch das Schreiben), `session <id>`, `tage <n>`,
`von <datum> bis <datum>`, `vergleich <id>`.

## Ablauf

### 1. Daten sammeln

```bash
npx tsx .claude/skills/netz-auswertung/scripts/collect.ts            # laufender Test, sonst letzter (≥ 30 min)
npx tsx .claude/skills/netz-auswertung/scripts/collect.ts --liste    # vorhandene Langzeittests
#   --session <id> | --tage <n> | --von "2026-10-10 18:00" --bis "…"  · --vergleich <id> · --db <pfad> · --out <ordner>
```

- Das Skript liest die Datenbank **nur lesend** und darf laufen, während die Mess-Engine misst. Nie die
  Datenbank verändern, nie die Engine stoppen.
- Es legt `berichte/<JJJJ-MM-TT_HHMM>/` an mit `fakten.md` (für dich) und `daten.json` (für render.ts) und gibt
  den Ordner aus.
- Hat der Nutzer etwas geändert (Kabel, Port, Treiber, Techniker), vergleiche mit dem Test davor:
  `--vergleich <id>`. Die IDs zeigt `--liste`; der Testname hilft (z. B. „LAN-Kabel“).
- Keine Datenbank oder keine Messdaten: Erkläre, wie man misst (`npm run start:all`, http://127.0.0.1:3000,
  „Langzeittest starten“, 48–72 h). Dann hier aufhören.

### 2. Lesen und verstehen

1. `fakten.md` vollständig lesen.
2. `reference/interpretation.md` lesen: Wegmodell, Schwellen, Muster → Ursache → Lösung, DOCSIS, Aussagekraft.
3. Für das Vodafone-Schreiben zusätzlich `reference/vodafone.md` lesen.

Dann selbst urteilen, nicht nur das App-Urteil abschreiben:
- **Gewichtung:** Was verursacht die meisten gestörten Sekunden (Abschnitt 2), was die schweren (SES, Ausfälle)?
  Was erklärt die Beschwerde des Nutzers (Lags > 200 ms, Verlust beim Spielen)?
- **Widersprüche prüfen.** Ein Beispiel: Das App-Urteil nennt Link-Abbrüche der letzten 7 Tage, aber im
  Zeitraum gab es 0 Abbrüche und der Test heißt „LAN-Kabel“. Dann hat der Kabeltausch wahrscheinlich gewirkt,
  und die aktuelle Hauptursache liegt woanders. So etwas offen benennen.
- `remote` (nur AWS-Ziele) nicht als Anschlussproblem werten, wenn Cloudflare und Google sauber sind.
- Bei < 24 h oder ohne Abend: klar „vorläufig“ schreiben und sagen, was noch fehlt.

### 3. Auswertung schreiben

`<ordner>/auswertung-inhalt.html` nach der Vorlage `templates/auswertung-inhalt.html` schreiben. Nur den
Körper; Stylesheet und Kopf fügt render.ts hinzu. Dann rendern:

```bash
npx tsx .claude/skills/netz-auswertung/scripts/render.ts <ordner> auswertung      # → auswertung.html + auswertung.pdf
```

Inhaltliche Regeln:
- **Oben die Antwort:** Überschrift = Kernaussage in einem Satz; Urteil-Box mit Hauptursache und Sicherheit;
  4 Kennzahlen.
- **„Was jetzt zu tun ist“ ist das Herzstück:** 3–6 nummerierte Schritte, priorisiert. Eigene schnelle
  Maßnahmen zuerst, dann Vodafone, dann Nachmessen. Jeder Schritt sagt, **was** zu tun ist (konkrete
  Handgriffe), **warum** (mit der Zahl, die es begründet), **wer** (Badge du, Vodafone oder dritte) und **woran
  man den Erfolg erkennt**. Immer nur eine Änderung zur Zeit, danach neu messen.
- Befunde als Karten: Zustand, Zuständigkeit, Zahl, Bedeutung. Dazu „Was in Ordnung ist“ (entlastet und
  grenzt ab).
- Grafiken über Platzhalter einsetzen: `<!--GRAFIK:abschnitte-->`, `<!--GRAFIK:verlauf-->`,
  `<!--GRAFIK:stundenprofil-->`. Die Varianten `abschnitte-anschluss` und `verlauf-anschluss` lassen die
  Sekunden weg, in denen nur einzelne Internet-Ziele gestört waren (`remote`). Sie passen, wenn es nur um den
  Anschluss geht; das Messprotokoll für Vodafone nutzt sie automatisch.
- Sprache: Deutsch mit korrekten Umlauten, **du-Form**, kurze Sätze, Fachwörter beim ersten Auftreten erklären
  (am Ende „Begriffe kurz erklärt“, nur die vorkommenden). Zahlen deutsch formatieren (12,5 ms; 1.234).
- **Nur Zahlen aus `fakten.md`.** Nichts erfinden, nicht hochrechnen. Gerundete Werte sind ok.

### 4. Vodafone-Dokument (wenn gewünscht oder sinnvoll)

Sinnvoll ist es nur, wenn die Daten eine Ursache auf Vodafone-Seite belegen (`reference/vodafone.md` → „Wann
ein Schreiben sinnvoll ist“). Liegt die Ursache beim Nutzer, sag das und biete das Schreiben höchstens für den
Vodafone-Anteil an. Wird es gewünscht:

1. `<ordner>/vodafone-anschreiben.html` nach `templates/vodafone-anschreiben.html` schreiben: eine Seite,
   **Sie-Form**, sachlich. Persönliche Daten nur, wenn der Nutzer sie im Chat genannt hat, sonst `[[Platzhalter]]`.
2. `<ordner>/vodafone-kurztext.txt` schreiben (≤ 900 Zeichen, für Online-Formular, Chat und Hotline).
3. Rendern; das Messprotokoll wird automatisch als Anlage angehängt:

```bash
npx tsx .claude/skills/netz-auswertung/scripts/render.ts <ordner> vodafone        # → vodafone-stoerungsmeldung.html + .pdf
npx tsx .claude/skills/netz-auswertung/scripts/render.ts <ordner> messprotokoll   # nur das Messprotokoll (optional)
```

render.ts listet die noch auszufüllenden Platzhalter („AUSFÜLLEN: …“). Nenne sie dem Nutzer. Du verschickst
**nichts** selbst; senden muss der Nutzer (Wege: `reference/vodafone.md`).

### 5. Abschluss im Chat

Kurz und ohne Wiederholung des Dokuments:
- Hauptursache in einem Satz, mit Sicherheit (vorläufig oder belastbar);
- die 3 wichtigsten nächsten Schritte;
- Pfade zu `auswertung.pdf` (und ggf. `vodafone-stoerungsmeldung.pdf`, `vodafone-kurztext.txt`) als klickbare Links;
- noch auszufüllende Platzhalter; Hinweis, dass `berichte/` persönliche Daten enthält (nicht veröffentlichen,
  `daten.json` nicht verschicken).

## Qualitätscheck vor dem Abschluss

- [ ] Jede Zahl im Dokument steht so in `fakten.md` (Stichprobe: 5 Zahlen nachprüfen).
- [ ] Hauptursache passt zur Verteilung der gestörten Sekunden; Widersprüche sind erklärt.
- [ ] Jeder Schritt hat Was, Warum, Wer und Erfolgskontrolle; eigene Maßnahmen stehen vor Vodafone.
- [ ] Aussagekraft ehrlich (Messdauer, Abend, Sicherheit).
- [ ] Vodafone-Schreiben: nur Vodafone-Anteile, keine `remote`-Störungen, keine erfundenen persönlichen Daten,
      keine Minderungsforderung ohne Breitbandmessung.
- [ ] render.ts lief ohne Warnung zu unbekannten Grafiken; PDF erzeugt (sonst Hinweis: HTML öffnen → Strg+P → „Als PDF speichern“).

## Dateien des Skills

| Datei | Zweck |
|---|---|
| `scripts/collect.ts` | Zeitraum wählen, Daten über die Server-Abfragen der App sammeln → `daten.json`, `fakten.md` |
| `scripts/render.ts` | HTML-Fragment + Grafiken + Stylesheet → HTML und PDF (Edge/Chrome headless, Windows und macOS) |
| `scripts/data.ts`, `digest.ts`, `anlage.ts`, `charts.ts`, `text.ts` | Datensammlung, Faktenblatt, Messprotokoll, SVG-Grafiken, Beschriftungen |
| `scripts/style.css` | Druck-Layout (A4) |
| `reference/interpretation.md` | Wie man die Zahlen deutet; Ursachen- und Lösungskatalog |
| `reference/vodafone.md` | Rechtslage (TKG), Aufbau und Ton der Störungsmeldung, Platzhalter, Nachverfolgung |
| `templates/*.html` | Vorlagen für Auswertung und Anschreiben |
