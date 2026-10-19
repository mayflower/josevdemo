# Josev Decision Lab

Fünf Browser-Demos mit synthetischen deutschen Beispielen für **Mayflower Josev-2B auf eurem internen Ollama**. Modellantworten lösen die Klassifikationsanimationen aus. Ein optionales Ollama-LLM bearbeitet dieselben Aufgaben für einen Vergleich von Laufzeit, Qualität und kalkulierten Ressourcenkosten.

## Schnell starten

Voraussetzung: **Node.js ab 22.9**, alternativ Docker Compose. Die Anwendung benötigt keine npm-Pakete, keine Datenbank, keine externen Schriftarten und keinen Build-Schritt.

```bash
cd josev-demo
cp .env.example .env
```

In `.env` die vorhandene interne Basis-URL und den tatsächlichen Modellnamen eintragen:

```dotenv
OLLAMA_BASE_URL=http://euer-ollama-host:11434
JOSEV_MODEL=josev-2b
```

`euer-ollama-host` und `josev-2b` sind **Platzhalter**. Verwendet den Modellnamen aus `ollama list` eures Servers. Es wird kein Modell automatisch heruntergeladen oder installiert. Die URL bezeichnet den Dienst, ohne `/api` oder `/v1/systemone`; ein vorhandener Reverse-Proxy-Pfadpräfix ist möglich.

```bash
npm start
```

Anschließend **http://localhost:3000** öffnen und **Verbindung prüfen** wählen. Dieser Test sendet einen kurzen echten Decision-Aufruf. Ein Modell in der Modellliste allein beweist noch nicht, dass eure Ollama-Version das importierte Josev-Modell über System One ausführen kann.

Ohne Konfiguration startet die Datenvorschau. Messungen bleiben gesperrt beziehungsweise melden die fehlenden Werte. Es gibt keine simulierten Modellantworten und keine vorgegebenen Geschwindigkeitsfaktoren.

### Optional: LLM und Kostensätze

```dotenv
LLM_MODEL=euer-vergleichsmodell
LLM_BASE_URL=
JOSEV_COST_PER_HOUR_EUR=
LLM_COST_PER_HOUR_EUR=
```

Eine leere `LLM_BASE_URL` verwendet denselben Ollama-Dienst wie Josev. Ein leeres `LLM_MODEL` aktiviert nur Josev. Tragt als Vergleich ein Modell ein, das ihr für diese Klassifikationsaufgaben tatsächlich einsetzen würdet. Es muss Ollamas JSON-Schema-Ausgaben und `think:false` unterstützen.

Die beiden Kostensätze sind optionale **EUR pro Stunde der jeweils bereitgestellten Rechenressource**, mit Dezimalpunkt. Leere Werte bedeuten „nicht konfiguriert“. Sie werden niemals als kostenlose Inferenz interpretiert. Bei derselben Ressource verwendet ihr denselben Verrechnungssatz, sofern eure Kostenrechnung nichts anderes vorsieht.

### Mit Docker Compose

```bash
docker compose up --build -d
```

Die zuvor ausgefüllte `.env` wird eingelesen. Läuft Ollama direkt auf dem Docker-Host, lautet dessen Basis-URL aus dem Container beispielsweise `http://host.docker.internal:11434`. Bei einem anderen internen Server verwendet ihr dessen erreichbaren Hostnamen. `localhost` innerhalb des Containers bezeichnet den Demo-Container selbst.

Die Webanwendung wird standardmäßig an `127.0.0.1:3000` des Hosts gebunden. Für eine vorhandene interne Veröffentlichung könnt ihr euren Reverse Proxy davorschalten; ein Beispiel liegt in `docs/nginx.conf.example`. Falls ihr direkt über die interne Hostadresse zugreifen möchtet, setzt `DEMO_BIND_ADDRESS` entsprechend. Der Container startet ausschließlich die Webanwendung und verwendet euren bestehenden Ollama.

## Die fünf Fälle

| Auswahl | Ansicht | Was das Modell entscheidet | Sichtbarer Effekt |
|---|---|---|---|
| **1** | Support-Triage | Fünf unabhängige Noul-Fragen: Kündigung, Rückerstattung, Ärger, technischer Fehler, expliziter Wunsch nach einem Menschen | Jede Ticketkarte erhält fünf Ja/Nein-Merkmale. Mehrere Merkmale können gleichzeitig zutreffen. |
| **2** | Semantischer Feed-Filter | Trifft eine deutsche Filterbedingung auf diesen Beitrag zu? | Beiträge werden entsprechend der tatsächlichen Antwort einsortiert. Vordefinierte Bedingungen und eigene Formulierungen sind möglich. |
| **3** | Rechnungswerte auswählen | Welche vorhandene Nummer, welcher Betrag, welches Datum oder welche E-Mail hat die gesuchte Rolle? | Originalwerte werden markiert und in fünf Felder übernommen. Ablenkende Werte bleiben im Dokument sichtbar. |
| **6** | Dokumente ordnen und trennen | Zu welcher Art gehört die Seite? Beginnt mit ihr ein neues Dokument? | Seiten erhalten Kategorien und Dokumentgrenzen, auch bei zwei direkt aufeinanderfolgenden Rechnungen. |
| **7** | 77 Banking-Intents | Welches Bankanliegen passt am besten zur Nachricht? | Nachrichten erscheinen im Raster mit allen 77 Kategorien. |

Enthalten sind **254 synthetische deutsche Eingaben**: 30 Support-Nachrichten, 36 Beiträge, 14 Rechnungs-/Belegtexte, 20 Dokumentseiten und 154 Banking-Nachrichten (zwei pro Intent). Alle Nachrichten, Rechnungen und Dokumentseiten wurden für diese Demo auf Deutsch verfasst. Die Banking-Kategorie-IDs stammen aus der ursprünglichen Banking77-Taxonomie; die Demo-Texte sind **keine übersetzten Banking77-Testfälle**. Die Trefferquote ist deshalb keine Banking77-Benchmarkzahl.

### 1 · Triage

Fünf Fragen stehen gemeinsam in **einem** System-One-Aufruf pro Nachricht. Die Aufgaben sind voneinander unabhängig; ein Ticket wird nicht zwangsweise in genau eine Schublade gesteckt. Die Sollwerte folgen den eng formulierten Fragen. „Mensch“ bedeutet hier einen ausdrücklichen Wunsch nach einer Person, keine versteckte Eskalationsrichtlinie.

### 2 · Feed-Filter

Vordefinierte Bedingungen besitzen synthetische Sollwerte. Bei einer frei formulierten Bedingung wird die Qualität als unbekannt behandelt, weil hierfür keine geprüften Sollwerte vorliegen. Laufzeit und tatsächlich gemeldete Antworten sind weiterhin messbar. Filtertexte werden erst nach dem Start übertragen, nicht bei jedem Tastendruck.

### 3 · Werteauswahl

Gemeinsame reguläre Ausdrücke sammeln Kandidaten für Rechnungsnummer, Zahlbetrag, Fälligkeitsdatum, PO-Nummer und Rechnungs-E-Mail. Das Modell bekommt eine Choice-Frage mit diesen Originalwerten und der zusätzlichen Option `none`. Es generiert keine Rechnungsdaten, rechnet keine Steuer aus und liest keine PDFs per OCR.

Sind für ein Feld keine Kandidaten vorhanden, ergibt die gemeinsame Vorverarbeitung `none`; hierfür wird keine Modellentscheidung behauptet. Der JSON-Export benennt solche `deterministicFields`. Maximal 25 Werte plus `none` passen in eine Frage. Die Originalwerte in den mitgelieferten Texten sind so gestaltet, dass die Kandidatensuche sie erfasst.

### 6 · Dokumentklassifikation und Seitentrennung

Die Demo zeigt synthetische Textseiten als Dokumentkarten. Beide Modelle erhalten dieselben bereits verfügbaren Seitentexte und jeweils die vorherige Seite als Kontext. Kategorie und Dokumentbeginn werden in einem gemeinsamen Aufruf entschieden. Das erfasst auch Grenzen zwischen gleichartigen Dokumenten. Ein PDF-Upload, eine OCR-Pipeline oder ein produktives Archiv gehören nicht zum Messpfad dieser Demo.

### 7 · Alle 77 Intents trotz 26 Optionen je Choice

Ollama dokumentiert höchstens 26 Optionen je Choice-Frage. Die App verwendet deshalb ein zweistufiges Verfahren:

1. **Ein Request mit drei Choice-Fragen:** Je ein Kandidat aus 26, 26 und 25 Kategorien.
2. **Ein zweiter Request:** Auswahl aus den drei Finalisten.

Beide Modelle verwenden dieselben ursprünglichen Kategorien und dieselbe Strategie. Die Finalisten entstehen jeweils aus den Antworten des jeweiligen Modells und können daher unterschiedlich sein. Beide Aufrufe, einschließlich des Übergangs zwischen ihnen, zählen zur Zeit pro Nachricht. Insgesamt werden vier Choice-Fragen beantwortet. Die finale Wahrscheinlichkeit bezieht sich nur auf die drei Finalisten; sie ist keine Verteilung über alle 77 Klassen.

Quellen für diese Grenze und das API-Format: [Ollama Decision Guide](https://docs.ollama.com/capabilities/decision), [System One API](https://docs.ollama.com/api/systemone). Die konkrete Anbindung und Antwortvalidierung sind in `docs/model-notes.md` beschrieben.

## So funktioniert die Vorführung

1. **Verbindung prüfen**, anschließend einen Fall wählen. Die Vorschau zeigt die echten Eingabebeispiele, bevor ein Modell aufgerufen wird.
2. Für eine kurze Vorführung zunächst etwa **12 Beispiele** wählen. Triage und Feed erklären das Prinzip schnell; Rechnungswerte und Dokumentgrenzen zeigen anspruchsvollere Entscheidungen.
3. **Josev allein** oder **mit LLM vergleichen** starten. Während des Laufs werden die Karten aus tatsächlichen Ergebnisereignissen aktualisiert.
4. Bei einem gemeinsamen Ollama die voreingestellte **Ausführung nacheinander** verwenden. Für einen gleichzeitigen Vergleich getrennte Ressourcen konfigurieren. Zwei verschiedene URLs allein garantieren noch keine getrennte GPU.
5. Ein abgeschlossener Vergleich lässt sich anhand der gemessenen Ankunftszeiten synchron wiedergeben. Die Oberfläche kennzeichnet diese Darstellung als **Replay**, die Ergebnisse und Messwerte stammen aus dem echten Lauf.
6. Den vollständigen Lauf als **JSON exportieren**. Darin stehen Modellnamen, Bedingungen, Parallelität, Warm-up, Messwerte, Antworten, Fehler und die synthetischen Beispiele.

Der **Präsentationsmodus** verdichtet die Ansicht auf Vergleich, Bedienung und Entscheidungen. Er funktioniert auch dann, wenn der Browser echtes Vollbild nicht erlaubt.

**Stopp** bricht die Browseranfrage und noch laufende Modellaufrufe ab. Die App startet keinen weiteren verdeckten Messlauf. Pro App-Instanz darf nur ein Lauf beziehungsweise Verbindungstest aktiv sein, damit andere Besucher die Messung nicht versehentlich überlagern.

## Was gemessen wird

### Zeit

- **Laufzeit:** Zeit vom Start der Messphase einer Modellspur bis zum Abschluss aller angeforderten Beispiele. Warm-up wird separat protokolliert.
- **Zeit pro Beispiel:** Zeit vom Beginn der Bearbeitung bis zur vollständig ausgewerteten Modellantwort; bei Banking einschließlich beider Stufen. Netzwerk, Ollama-Warteschlange und gegebenenfalls Modellladen gehören dazu.
- **p50 / p95:** Nearest-rank-Perzentile der erfolgreich abgeschlossenen Beispiele. Bei wenigen Beispielen ist insbesondere p95 wenig stabil; die Anzahl steht im Export.
- **Durchsatz:** Erfolgreich abgeschlossene Beispiele pro Sekunde der gesamten Messphase.
- **Token:** Ausschließlich Zähler aus der Modellantwort. Nicht gemeldete Werte bleiben unbekannt; tatsächlich gemeldete `output_tokens: 0` werden angezeigt.

Die Laufzeit enthält keine künstliche Animationspause. Eine langsame Animation hält die Modellbearbeitung nicht absichtlich auf. Bei ungewöhnlich langsamer Browserverbindung kann die Übertragung wie bei jeder gestreamten Anwendung Rückstau erzeugen. Für reproduzierbare Talk-Messungen bleiben Hardware, Quantisierung, Eingaben, Parallelität und Hintergrundlast konstant.

### Warm-up und gemeinsamer Server

Standardmäßig lädt eine separate kurze Anfrage das jeweilige Modell vor der Messung. Sie verwendet keinen Demo-Fall, um nicht gezielt das erste Beispiel aufzuwärmen. Ihre Zeit und Token werden separat exportiert. Ohne Warm-up können Ladezeiten im Messlauf enthalten sein. Ein zuvor verwendeter Server kann weiterhin Prompt- oder Modellcache enthalten; die App bezeichnet daher einen Lauf ohne Warm-up nicht automatisch als garantiert kalt.

Auf einem gemeinsamen Ollama würden gleichzeitig gestartete Modelle um Speicher und Rechenzeit konkurrieren oder einander verdrängen. Deshalb blockiert die App den parallelen Vergleich bei identischer Basis-URL. Die sequenzielle Reihenfolge ist Josev, danach LLM; sie wird mitprotokolliert. Der synchronisierte Replay stellt die jeweils eigenen gemessenen Zeiten nebeneinander, ohne daraus einen tatsächlich gleichzeitigen Lauf zu machen.

### Qualität

Jede synthetische Sollentscheidung wird mit der Modellantwort verglichen. Bei fünf Triage-Fragen bedeutet beispielsweise 4/5 vier richtige Einzelentscheidungen. Bei einem Fehler gelten die betroffenen Sollentscheidungen als nicht erfüllt. Fehler und übersprungene Beispiele bleiben sichtbar. Außerdem enthält der Export die Anzahl vollständig richtig entschiedener Beispiele.

Eigene Texte und frei formulierte Feed-Bedingungen besitzen keine hinterlegten Sollwerte. Dafür wird keine Trefferquote erfunden. Die mitgelieferten Sollwerte sind eine prüfbare Demonstrationsgrundlage und kein unabhängiger wissenschaftlicher Benchmark.

### Kosten

```text
kalkulierte Laufkosten = Laufzeit der Modellspur in Stunden × Ressourcensatz in EUR/h
```

Diese Rechnung nimmt an, dass der angegebene Ressourcensatz der jeweiligen Modellspur während ihrer Messphase zugeordnet wird. Sie umfasst die gemessene Warte- und Netzzeit. Sie misst weder Stromverbrauch noch tatsächlich fakturierte Cloud-Kosten. Bei mehreren gleichzeitigen Anfragen wird das Zeitintervall nur einmal verrechnet; einzelne Anfragelatenzen werden nicht doppelt addiert. Eine Prognose „pro 1.000 Beispiele“ wird nur aus vollständig erfolgreichen Läufen gebildet und ausdrücklich hochgerechnet.

Schneller ist nicht automatisch wirtschaftlicher, wenn gleichzeitig mehr Fehler auftreten. Laufzeit, Kosten und Qualität stehen deshalb nebeneinander. Bei fehlenden Kostensätzen oder unvollständigen Läufen wird kein unbelegter Ersparnisfaktor ausgegeben.

## Betrieb und Konfiguration

| Variable | Bedeutung | Standard |
|---|---|---|
| `OLLAMA_BASE_URL` | Basis-URL des internen Josev-Dienstes | leer |
| `JOSEV_MODEL` | Exakter Ollama-Modellname | `josev-2b`, Beispielalias |
| `OLLAMA_API_KEY` | Optionaler Bearer-Schlüssel für den internen Proxy | leer |
| `LLM_PROVIDER` | `ollama` oder `openai` (offizielle OpenAI-API, Chat Completions mit striktem JSON-Schema) | `ollama` |
| `LLM_BASE_URL` | Optional separater Ollama für den Vergleich | Josev-Basis-URL |
| `LLM_MODEL` | Vergleichsmodell; leer deaktiviert Vergleich | leer |
| `LLM_API_KEY` | Optionaler Schlüssel des Vergleichsdienstes | Josev-Schlüssel |
| `JOSEV_COST_PER_HOUR_EUR` | Ressourcensatz für Josev in EUR/h | unbekannt |
| `COST_CURRENCY` | Währung der Kostenanzeige, `EUR` oder `USD` | `EUR` |
| `JOSEV_PRICE_INPUT_PER_MTOK`, `JOSEV_PRICE_OUTPUT_PER_MTOK` | Tokenpreis Josev je 1 Mio. Eingabe-/Ausgabetoken; hat Vorrang vor dem Stundensatz | leer |
| `LLM_PRICE_INPUT_PER_MTOK`, `LLM_PRICE_OUTPUT_PER_MTOK` | Tokenpreis des Vergleichsmodells je 1 Mio. Token | leer |
| `LLM_COST_PER_HOUR_EUR` | Ressourcensatz für das LLM in EUR/h | unbekannt |
| `MODEL_KEEP_ALIVE` | Ollama-Haltedauer nach Anfragen | `10m` |
| `REQUEST_TIMEOUT_MS` | Zeitgrenze je Modellrequest | `120000` |
| `MAX_CONCURRENCY` | Obergrenze der Anfragenparallelität je Modellspur | `4` |
| `HOST`, `PORT` | Bindung des Node-Servers | `127.0.0.1:3000` |
| `DEMO_BIND_ADDRESS`, `DEMO_PORT` | Docker-Portbindung auf dem Host | `127.0.0.1:3000` |

Ein Request bei Banking zählt als eine Stufe; ein Beispiel kann daher bis zu zwei Request-Zeitgrenzen benötigen. Nach einem Verbindungsfehler, Timeout oder wiederholten Modellfehlern stoppt die betroffene Spur weitere Arbeit und markiert verbleibende Beispiele als übersprungen.

Die Demo enthält keine eigene Benutzerverwaltung und speichert keine Läufe auf dem Server. Die vorhandene interne Zugangskontrolle kann vor die Anwendung gesetzt werden. Zugangsschlüssel bleiben serverseitig; Browser-Konfiguration und Exporte enthalten keine API-Schlüssel und keine vollständigen internen Dienst-URLs. Der App-Server ruft ausschließlich die administrativ konfigurierten Dienste auf. Besucher können keine beliebigen Ziel-URLs einsetzen.

Bei einem Reverse Proxy muss Response-Buffering ausgeschaltet bleiben, damit die Klassifikationsereignisse sofort im Browser erscheinen. Die Anwendung sendet dafür `X-Accel-Buffering: no`; ein Nginx-Beispiel ist enthalten. Die Modellanfragen erfolgen vom App-Server, weshalb Ollamas Browser-CORS-Konfiguration dafür nicht geändert werden muss.

## Modellhinweise

Die [Mayflower-Modellkarte](https://huggingface.co/mayflowergmbh/Josev-2B-GGUF) empfiehlt Q8_0. Sie beschreibt Josev als Decision-Modell mit typisierten Fragen über `/v1/systemone` und dokumentiert seinen GGUF-Betrieb über llama.cpp. Ollamas aktuelle System-One-Dokumentation nennt Version 0.35.0 oder neuer; eure Version muss zusätzlich den konkreten Josev-Import unterstützen. Dies prüft die App durch einen echten Aufruf, nicht durch eine Annahme über den Modellnamen.

Für längere Aufgaben wie Banking oder Dokumente müssen Kontext und Batch-Kapazität eurer Runtime ausreichen. Ein HTTP-500-Fehler wird sichtbar gemeldet. Die App wechselt dann nicht auf einen Chat-Aufruf oder einen anderen Anbieter. Genaueres, einschließlich der Grenzen der dokumentierten Modellqualität, steht in `docs/model-notes.md`.

## Entwicklung und Prüfung

```bash
npm test
npm run check
```

Die Tests verwenden ausschließlich lokale HTTP-Testdienste beziehungsweise injizierte Testadapter. Sie prüfen das API-Format, Antwortvalidierung, Streaming, Laufsteuerung, Abbruch, Messwertberechnung und die Konsistenz der Beispieldaten. Sie messen keine Josev-Geschwindigkeit und ersetzen nicht den Verbindungstest auf eurem internen Server.

Das Startpaket wurde mit 32 erfolgreichen automatisierten Tests geprüft. Die fünf Ergebnisansichten, Präsentationsmodus, Abbruch und Replay wurden zusätzlich im Browser mit einem ausdrücklich gekennzeichneten lokalen Testdienst geprüft. Ein Lauf auf eurem internen Ollama und der Bau des Docker-Images stehen noch aus.

```text
public/                 Browser-Oberfläche und Animationen
data/fixtures.mjs       Deutsche Beispiele, Sollwerte und Kategorien
lib/providers.mjs       System-One- und Ollama-Chat-Adapter
lib/tasks.mjs           Entscheidungsfragen und Kandidatensuche
lib/runner.mjs          Laufsteuerung, Qualität und Messwerte
lib/config.mjs          Serverseitige Konfiguration
server.mjs              HTTP-API und statische Dateien
tests/                  Automatisierte Integrations- und Adaptertests
docs/                   Betriebs- und Modellhinweise
```

## Vorbilder und Quellen

Die Umsetzung ist eine eigenständige Demo mit neuen deutschen Texten. Die ausgewählten Aufgaben orientieren sich an diesen veröffentlichten Decision-Demos:

- [OpenRouter Jev: Triage](https://openrouter.ai/labs/jev/triage)
- [OpenRouter Jev: Feed](https://openrouter.ai/labs/jev/feed)
- [OpenRouter Jev: Extract](https://openrouter.ai/labs/jev/extract)
- [DocJev: Dokumentklassifikation und Seitentrennung](https://github.com/jerryjliu/docjev)
- [PolyAI Banking77: Originale Kategorien](https://github.com/PolyAI-LDN/task-specific-datasets/tree/master/banking_data)
- [Josev-2B-GGUF](https://huggingface.co/mayflowergmbh/Josev-2B-GGUF)
- [Ollama System One](https://docs.ollama.com/api/systemone)
- [Ollama Chat API](https://docs.ollama.com/api/chat)

Details zur Herkunft und zur Abgrenzung der synthetischen Daten stehen in `data/SOURCES.md`. Fremde Laufzeit- oder Preisangaben werden nicht als Ergebnisse dieser Anwendung übernommen.
