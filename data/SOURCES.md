# Daten und Quellen

## Synthetische deutsche Vorführdaten

Alle Nachrichtentexte, Feed-Beiträge, Rechnungen, Dokumentseiten, deutschen Kategorienamen und Kriterien in `fixtures.mjs` wurden für diese Demonstration neu auf Deutsch verfasst. Sie enthalten keine echten Kundenfälle. Namen bezeichnen Musterbetriebe; E-Mail-Adressen verwenden die reservierte Endung `.example`. Die Dokumente sind synthetische Textseiten, keine OCR-Ergebnisse echter eingescannter Dokumente.

Die Einträge unter `expected` beziehungsweise `expectedByPreset` sind redaktionell festgelegte Sollantworten. Sie sind keine vom Modell erzeugten Ergebnisse. Eine Übereinstimmungsrate auf diesen bewusst übersichtlichen Beispielen erlaubt keine Aussage über die Genauigkeit auf echten Unternehmensdaten oder einem unabhängigen Benchmark. Wird ein Text oder Filter geändert, ist eine bestehende Sollantwort für diesen geänderten Fall nicht automatisch gültig.

Umfang: 30 Support-Nachrichten mit je fünf unabhängigen binären Sollantworten; 36 Feed-Beiträge mit drei Filterkriterien; 14 Belegtexte mit je fünf zu wählenden Feldern; 20 Dokumentseiten in drei Stapeln; 154 Banking-Nachrichten mit zwei Beispielen je Intent. Insgesamt 254 synthetische Eingaben.

Für Rechnungen bezeichnet `total_due` den ausdrücklich aktuell offenen Zahlbetrag, vor optionalem, noch nicht genutztem Skonto. `due_date` bezeichnet den angegebenen regulären Fälligkeitstermin, `billing_email` den ausdrücklich für Rechnungsfragen zuständigen Kontakt. Werte müssen unverändert im Text vorkommen. `none` bedeutet, dass die gesuchte Angabe für den aktuellen Beleg fehlt, auch wenn ein abweichender Kandidat in einem zitierten alten Vorgang vorkommt.

Bei Dokumenten gilt die erste Seite jedes Stapels als Beginn eines neuen Dokuments. Jede weitere Seite wird zusammen mit der unmittelbar vorangehenden Seite desselben Stapels betrachtet. Zwei verschiedene Rechnungen können dieselbe Kategorie haben und trotzdem eine neue Dokumentgrenze bilden.

## Banking77-Taxonomie

Die 77 technischen Intent-IDs wurden aus der Original-Kategorienliste von PolyAI übernommen. Die Großschreibung in `Refund_not_showing_up` und das Fragezeichen in `reverted_card_payment?` wurden absichtlich beibehalten. Einige historischen IDs sind missverständlich: `get_physical_card` bezeichnet im Originalmaterial das Finden oder Erhalten der Karten-PIN; `order_physical_card` die Bestellung der physischen Karte. `receiving_money` umfasst insbesondere Gehaltseingang. Die deutschen Kriterien präzisieren diese Bedeutungen.

Primärquellen, gelesen am 19.10.2026:

- Original-Repository: https://github.com/PolyAI-LDN/task-specific-datasets
- Original-Kategorienliste: https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/categories.json
- Ursprüngliche Trainingsdatei, nur zur Prüfung missverständlicher Kategorien gelesen: https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/train.csv
- PolyAI-Dataset-Karte: https://huggingface.co/datasets/PolyAI/banking77
- Original-Lizenz: https://github.com/PolyAI-LDN/task-specific-datasets/blob/master/LICENSE

Attribution: Banking77, © PolyAI Limited, Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/ . Iñigo Casanueva, Tadas Temčinas, Daniela Gerz, Matthew Henderson und Ivan Vulić (2020): *Efficient Intent Detection with Dual Sentence Encoders*, Proceedings of the 2nd Workshop on NLP for Conversational AI. https://arxiv.org/abs/2003.04807

Änderungen gegenüber dem Original: Hier werden ausschließlich die technischen Kategorie-IDs weiterverwendet. Deutsche Anzeigenamen, Entscheidungskriterien und sämtliche Äußerungen sind neu erstellt. Die Daten sind weder eine Übersetzung noch eine Teilmenge der originalen Trainings- oder Testäußerungen. Ergebnisse dürfen daher nicht als offizielles Banking77-Benchmarkresultat bezeichnet werden.

## Vorbilder für die fünf ausgewählten Vorführungen

- Support-Triage: https://openrouter.ai/labs/jev/triage
- Semantischer Feed-Filter: https://openrouter.ai/labs/jev/feed
- Auswahl aus Extraktionskandidaten: https://openrouter.ai/labs/jev/extract
- Dokumentklassifikation und Dokumentgrenzen: https://github.com/jerryjliu/docjev und https://jerryjliu.github.io/docjev/
- Banking77-Klassifikationsvergleich: https://openrouter.ai/blog/insights/jev-vs-claude-opus-5-classification/

Diese Seiten sind konzeptionelle Vorbilder. Ihre englischen Beispieltexte, Ergebnisse, Kosten- und Geschwindigkeitsangaben wurden nicht als deutsche Demo-Daten oder Messergebnisse übernommen. Zeit, Ergebnisse und gegebenenfalls Kosten entstehen erst beim konkreten Lauf gegen die konfigurierten Endpunkte.
