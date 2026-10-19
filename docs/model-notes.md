# Modellanbindung und Grenzen

Stand der überprüften Dokumentation: 19. Oktober 2026.

## Josev ist ein Decision-Modell

Der Adapter verwendet ausschließlich `POST /v1/systemone` mit `model`, `state`, `questions` und optional `keep_alive`. `state` kann deutscher Text oder ein JSON-Objekt sein. Jede Frage hat eine Kennung, `type`, `instructions` und gegebenenfalls `criteria`. Die Anwendung ersetzt diesen Aufruf bei einem Fehler nicht durch einen Chat-Aufruf oder vorbereitete Antworten.

Ollama dokumentiert System One für lokale Modelle ab Version 0.35.0. Eine installierte Version mit diesem Endpunkt muss zusätzlich die Architektur und Metadaten des importierten Josev-Modells unterstützen. Das ist durch die Modellkarte für eure konkrete Ollama-Installation noch nicht bestätigt. Der Verbindungstest muss deshalb einen echten Decision-Aufruf erfolgreich ausführen; ein Modellname in `/api/tags` allein genügt nicht.

Quellen: [Ollama System One API](https://docs.ollama.com/api/systemone), [Ollama Decision Guide](https://docs.ollama.com/capabilities/decision).

## Auswertung der Antworten

- **Noul:** `answers[id].noul` ist die Wahrscheinlichkeit von `true`, zwischen 0 und 1. Die Demo entscheidet bei `p >= 0.5` auf `true`. Ein Wert von 0,08 bedeutet 8 % Wahrscheinlichkeit für Ja; er ist nicht die Sicherheit der ausgewählten Nein-Antwort.
- **Choice:** `choice` ist ein Schlüssel der übergebenen Optionen. `probabilities` enthält die Verteilung über alle Optionen. Die angezeigte Wahrscheinlichkeit stammt aus `probabilities[choice]`. Das separate Feld `confidence` wird nicht als Wahrscheinlichkeit verwendet.
- Fehlende Antworten, unbekannte Optionen oder ungültige Wahrscheinlichkeiten werden als Fehler behandelt. Es gibt keine automatische Korrektur durch erfundene Werte.

Der dokumentierte Ollama-Endpunkt erlaubt pro Choice-Frage **2 bis 26 Optionen**. Ein Banking-Durchlauf mit allen 77 Klassen benötigt daher mehrere Fragen beziehungsweise Stufen. Ein solches Verfahren ist eine eigene Klassifikationsstrategie; es entspricht keinem einzelnen 77-fachen Choice-Aufruf. Für einen fairen Modellvergleich muss das Vergleichsmodell dieselbe Aufteilung erhalten.

Quelle: [Ollama Decision Guide: Question types](https://docs.ollama.com/capabilities/decision#question-types).

## GGUF und Modellimport

Die Mayflower-Modellkarte empfiehlt `Josev-2B-Q8_0.gguf`. Sie beschreibt einen Clef-GGUF-Export mit Kalibrierungswerten pro Fragetyp und belegt den Betrieb über `llama-server /v1/systemone`. Dort nennt sie llama.cpp **b11443 oder neuer**, getestet mit b11541. Der gesamte Request wird in einem Batch verarbeitet; die Batch- und Microbatch-Grenzen müssen für den vollständigen Input ausreichen. Diese llama.cpp-Schalter sind keine direkt übertragbare Ollama-Konfiguration.

Die dokumentierten Messwerte der Modellkarte gehören zu ihren eigenen Datensätzen und ihrer Runtime. Die Karte beschreibt Schwächen in den dort geprüften Business-Workflows. Daraus folgt keine vorab bekannte Qualität, Latenz oder Kostenersparnis für die synthetischen deutschen Beispiele dieser Anwendung. Ergebnisse der Demo werden erst aus den tatsächlichen Antworten des verbundenen Servers berechnet.

Quelle: [Mayflower Josev-2B-GGUF Modellkarte](https://huggingface.co/mayflowergmbh/Josev-2B-GGUF). Das [PyTorch-Ursprungsmodell](https://huggingface.co/mayflowergmbh/Josev-2B) ist dort ebenfalls verlinkt. Es wurden keine Modellgewichte für die Entwicklung heruntergeladen.

## LLM-Vergleich

Der zweite Adapter ruft Ollamas `POST /api/chat` auf. Er erhält denselben Zustand und dieselben Entscheidungsfragen. `format` enthält ein JSON-Schema mit Boolean- beziehungsweise Enum-Feldern, `stream` ist `false`, `think` ist `false`, die Temperatur ist 0. Das Vergleichsmodell soll ausschließlich die Entscheidungen liefern. Die Anwendung erfindet keine Wahrscheinlichkeiten für diese Antworten.

Die lokale Ollama-Version und das Vergleichsmodell müssen das verwendete Schema und `think:false` unterstützen. Eine Ablehnung wird sichtbar als Fehler gemeldet; es gibt keinen versteckten weiteren Versuch mit anderer Konfiguration. Modelle, Hardware, Quantisierung, Kontext, Parallelität, Warmzustand und Laufreihenfolge sollten beim Vergleich angegeben werden.

Quellen: [Ollama Chat API](https://docs.ollama.com/api/chat), [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs).

## Zeiten, Token und Kosten

`timing.wallMs` misst den tatsächlichen Aufruf vom Webserver bis zur vollständig eingelesenen JSON-Antwort. Damit umfasst er Verbindung, Warteschlange, mögliches Laden des Modells und Inferenz. Ollamas optionale Nanosekundenwerte werden nur übernommen, wenn sie vorliegen. `computeMs` wird aus `prompt_eval_duration` plus `eval_duration` berechnet, wenn beide vorhanden sind. Der öffentliche System-One-Antwortvertrag garantiert diese Zeitfelder nicht; fehlende Werte bleiben `null`.

Josev-Tokenzahlen stammen aus `usage.input_tokens` und `usage.output_tokens`; LLM-Tokenzahlen aus `prompt_eval_count` und `eval_count`. Gemeldete null Ausgabetoken sind ein tatsächlicher Zählerwert. Nicht gemeldete Tokenzahlen bleiben unbekannt. Lokale Inferenz ist dadurch nicht kostenlos. Eine Kostenrechnung muss einen angegebenen Verrechnungssatz und eine nachvollziehbare Zeit- oder Tokenbasis verwenden.

Die Adaptertests arbeiten ausschließlich gegen einen lokalen HTTP-Testserver. Sie prüfen den übertragenen API-Vertrag, Antwortvalidierung, Zeitgrenzen, Abbruch und Fehlermeldungen. Sie messen keine Josev- oder LLM-Leistung und ersetzen keinen Verbindungstest mit eurem internen Ollama.
