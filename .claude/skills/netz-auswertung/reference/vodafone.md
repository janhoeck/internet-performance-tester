# Störungsmeldung an Vodafone

## Ziel und Rechtslage (geprüft am 10.10.2026 auf gesetze-im-internet.de, kein Rechtsrat)

- **§ 58 Abs. 1 TKG:** Der Anbieter muss eine Störung „unverzüglich und unentgeltlich“ beseitigen. Der Kunde
  muss bei der Entstörung mitwirken, also Technikertermin und Zugang zum Hausanschluss ermöglichen.
- **§ 58 Abs. 2 TKG:** Störungsmeldungen und Termine werden dokumentiert. Kann der Anbieter nicht binnen eines
  Kalendertags entstören, muss er spätestens am Folgetag über Maßnahmen und voraussichtliche Dauer informieren.
- **§ 58 Abs. 3 TKG:** Eine Entschädigung (ab dem 3. Tag 5 € bzw. 10 %, ab dem 5. Tag 10 € bzw. 20 % des
  Monatsentgelts pro Tag) gibt es nur bei **vollständigem Ausfall**, nicht bei Latenzspitzen.
- **§ 58 Abs. 4 TKG:** Für einen versäumten Techniker-Termin gibt es 10 € bzw. 20 % des Monatsentgelts.
- **§ 57 Abs. 4 TKG:** Minderung oder Sonderkündigung erfordern bei Festnetz-Internet einen Nachweis mit dem
  Messverfahren der Bundesnetzagentur (Breitbandmessung Desktop-App; 30 Messungen an 3 Tagen innerhalb von 14 Tagen).
  Die Netzpuls-Messungen sind **kein** zertifizierter Nachweis. Sie belegen die Störung und begründen die
  Entstörung, aber keine Minderung.
- **Schlichtung:** Hilft Vodafone nicht, kann die Verbraucherschlichtungsstelle Telekommunikation der
  Bundesnetzagentur angerufen werden.

**Daraus folgt:** Das Schreiben verlangt die Entstörung (Prüfung der Leitung, Techniker), eine Ticketnummer und
eine Rückmeldung. Mit Minderung oder Kündigung droht es nicht, solange keine Breitbandmessung vorliegt. Sachlich
bleiben, das wirkt besser.

## Wann ein Schreiben sinnvoll ist

Nur wenn die Daten eine Ursache **auf Vodafone-Seite** zeigen (`access`, `aftr`, `backbone`, DOCSIS
grenzwertig/kritisch, Router-Defekt, Ausfälle in den Klassen docsis/aftr/isp). Liegt die Hauptursache beim
Nutzer (Link-Abbrüche, Bufferbloat durch eigene Uploads) oder beim Spieleserver (`remote`), dann:
1. das dem Nutzer offen sagen,
2. zuerst die eigenen Maßnahmen empfehlen,
3. ein Schreiben nur zu dem Teil anbieten, der wirklich bei Vodafone liegt (z. B. DOCSIS kritisch und
   `access`-Sekunden), und erwähnen, dass die eigene Seite bereits behoben ist bzw. wird.

Ein Schreiben mit Vorwürfen, die die Messung nicht trägt, schwächt die Position beim Support.

## Was Vodafone wissen will (docsis-thresholds.md §13, Moderatoren-Antworten)

- Angeschlossen **per LAN-Kabel**, nicht WLAN; Router gemietet (Vodafone Station). Vodafone kann die Werte dann
  auch selbst auslesen.
- **Zeitmuster:** rund um die Uhr oder nur abends (18–22 Uhr)? Seit wann?
- Ping-Messungen gegen den Router und den ersten Vodafone-Knoten. Genau das liefert das Messprotokoll.
- Router-Log (T3/T4), DOCSIS-Werte, Speedtest per LAN.
- Was der Kunde schon getan hat: Router-Neustart, Kabel getauscht, Powerline entfernt, anderes Gerät.
- Aktualität: Vodafone sieht Netzdaten nur für die letzten Tage. Das Schreiben zeitnah nach der Messung senden
  und Messung weiterlaufen lassen.
- Für einen Techniker: Zugang zu Keller, Hausübergabepunkt und Verstärker; mögliche Termine.

## Aufbau des Anschreibens (`vodafone-anschreiben.html`)

1. Absender, Empfänger (Anschrift aus der Rechnung, Platzhalter), Datum.
2. **Betreff:** „Störungsmeldung Kabel-Internet: …“ plus Kundennummer und Anschlussadresse als Platzhalter.
3. **Sachverhalt** (3–5 Sätze): seit wann, welche Symptome (Ping-Spitzen > 200 ms, Paketverlust, Abbrüche beim
   Spielen und in Videocalls), Messzeitraum.
4. **Messergebnis** (Liste, nur belegte Zahlen aus `fakten.md`):
   - Anteil gestörter Sekunden im Vodafone-Abschnitt; p99 bzw. Spitzen am 1. Vodafone-Knoten im Vergleich zum Router;
   - DOCSIS-Auffälligkeiten mit Kanal, Wert und Bewertung nach Vodafone-Servicetabelle;
   - Zeitmuster (Tagesprofil);
   - Ausfälle (Anzahl, Dauer), sofern Vodafone-Seite.
5. **Ausschluss der Hausseite:** LAN-Kabel, Router-Ping p99 und Verlust, keine eigene Last, kein VPN; erledigte Maßnahmen.
6. **Bitte** (nummeriert): Leitung und Segment prüfen; Techniker zum Einmessen bzw. Prüfen der Hausverteilung;
   Ticketnummer; Rückmeldung zu Maßnahmen und Zeitrahmen (§ 58 Abs. 2 TKG).
7. Hinweis auf die Anlage (Messprotokoll); Erreichbarkeit; Gruß; Name.

Länge: höchstens eine Seite. Ton: sachlich, freundlich, bestimmt; Sie-Form. Keine Fachbegriffe ohne Not; wenn
doch, dann die Vodafone-üblichen (CMTS, DOCSIS, Pegel, SNR/MER, T3/T4, Rückweg).

## Platzhalter

Persönliche Daten nie erfinden und nicht aus dem System ableiten. Als `[[Platzhalter]]` stehen lassen, wenn
der Nutzer sie nicht im Chat genannt hat: `[[Vorname Nachname]]`, `[[Straße Nr.]]`, `[[PLZ Ort]]`,
`[[Kundennummer]]`, `[[Anschrift laut Rechnung]]`, `[[Telefon]]`, `[[E-Mail]]`, `[[Ticketnummer (falls vorhanden)]]`,
`[[mögliche Technikertermine]]`. render.ts hebt sie gelb hervor und listet sie auf.

## Kurztext für Chat, Hotline und Online-Formular (`vodafone-kurztext.txt`)

Höchstens ca. 900 Zeichen, reiner Text: Symptom, Messzeitraum, 2–3 Kernzahlen, Ausschluss Hausseite, Bitte um
Techniker bzw. Leitungsprüfung, Hinweis „Messprotokoll als PDF liegt vor“. Das passt in die Textfelder des
Online-Formulars bzw. Chats unter „MeinVodafone → Hilfe → Störung melden“ und dient der Hotline als Vorlage.

## Was nicht hinein gehört

- Passwörter, MAC-Adressen des PCs, interne Pfade, Rohdaten-JSON (`daten.json` enthält lokale Adressen; nicht verschicken).
- Spekulationen über Vodafone-Interna; Drohungen; rechtliche Forderungen ohne Grundlage (siehe oben).
- `remote`-Störungen (AWS-Ziele) als Vodafone-Problem.

## Nach der Meldung

- Ticketnummer und Datum notieren (in Netzpuls als Notiz „Störung gemeldet, Ticket …“ über „Lag markieren“, damit
  es im Verlauf steht).
- Messung weiterlaufen lassen. Nach Technikerbesuch bzw. Maßnahme einen neuen Langzeittest starten und mit
  `collect.ts --vergleich <alte Test-ID>` vorher/nachher gegenüberstellen.
- Keine Besserung nach angemessener Frist: freundlich nachfassen mit neuem Messprotokoll; als letzter Schritt
  die Schlichtungsstelle der Bundesnetzagentur. Bei zu wenig Geschwindigkeit: Breitbandmessung starten.
