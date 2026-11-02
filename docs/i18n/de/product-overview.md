> **German edition (Tier-2 overview)** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source baseline: 2026-10-15 · Glossary: [../GLOSSARY.md](../GLOSSARY.md) · Governance: [../README.md](../README.md)

# YuanBingKe (ybkk-AIOS) — Enterprise-Plattform für KI-Ressourcenmanagement

**Positionierung:** Eine Enterprise-Plattform für KI-Ressourcenmanagement auf Basis der dsh-Architektur
„Everything is a plugin“ („Alles ist ein Plugin“).

YuanBingKe (chinesischer Originalmarkenname: 元冰可, Produktcode ybkk-AIOS) ist eine self-hosted
Enterprise-Plattform zur zentralen Verwaltung von KI-Ressourcen. Sie basiert auf der Architektur von
dsh (DeepSeek Harness). Sechs Asset-Typen werden unter einer einzigen Identität (IAM/OIDC-SSO), einem
Berechtigungssystem, einer Nutzungsmessung und einem Audit geführt.

## Ausgangslage und Lösungsansatz

In vielen Unternehmen entstehen KI-Inseln: MCP-Dienste, Skills, Agenten und KI-Anwendungen werden
dezentral betrieben — mit getrennten Konten, ungeklärten Berechtigungen, intransparenten Modellkosten
und ohne belastbare Audit-Spuren. Für IT-Leitung und Compliance ist weder nachvollziehbar, wer welche
KI-Ressource nutzt, noch was sie intern kostet und welche Risiken sie birgt.

YuanBingKe beantwortet das mit einer einheitlichen Control-Plane: eine Identität, ein Berechtigungsmodell,
eine transparente Nutzungsmessung und ein durchgängiger Audit-Trail für alle KI-Assets. Änderungen
durchlaufen definierte Freigabe- und Genehmigungsstufen (Entwurf → Prüfung → Canary → Rollout), und
jede Aktion wird revisionssicher protokolliert. Als self-hosted Plattform bleibt alles innerhalb der
IT-Grenze des Unternehmens.

## Sechs Asset-Typen, ein Fundament

- **MCP-Dienste** — versionierte Bereitstellung mit Canary-Freigabe, unveränderlichen Releases und Token-Gateway auf Tool-Ebene.
- **Skills** — geprüfte Fähigkeiten aus dem Skill-Marktplatz, nach statischer Analyse und zweistufiger Freigabe versioniert veröffentlicht.
- **Agenten** — registrierte Agenten mit Maschinen-Anmeldedaten, Organisationsrolle und definierten Autonomiestufen.
- **KI-Anwendungen** — interne und externe Apps mit SSO-Anbindung, Kennzahlen (PV/UV/DAU) und Kostensichtbarkeit.
- **Modellrouten** — modellagnostischer Zugang über das Model Access Gateway mit Kanal-Governance.
- **NAS-Dateispeicher** — Dateiablagen als verwaltete Asset-Klasse mit Datenberechtigungen und signierten Downloads.

## Leistungshighlights

- **Einheitliches IAM**: mehrstufiger Organisationsbaum, Rollen und Benutzergruppen, Berechtigungsmatrix;
  OIDC-Provider (RS256/JWKS/PKCE) als SSO für angebundene KI-Anwendungen inklusive Go-Live-Gate.
- **MCP-Deployment mit Kontrollen**: Ablauf draft → validate → canary → full rollout, unveränderliche
  Versionen, One-Click-Rollback, Token-Gateway mit Rechtegruppen, Tool-Granularität und
  Nur-Lese-Beschränkung, Circuit Breaking und P95-Monitoring.
- **Skill-Marktplatz mit Prüfkette**: Einreichung → statische Analyse (automatische Ablehnung bei
  Schadcode oder Schlüssellecks) → zweistufige Freigabe → versionierte Veröffentlichung; Vertragsprüfung
  per Ed25519-Signatur.
- **Agenten mit gesteuerter Autonomie**: Maschinen-Anmeldedaten, on-behalf-of-Token-Kette,
  Orchestrierungstopologie auf einen Blick; Autonomiestufen A0–A3 und A2A-gezielte Aufrufe zwischen Agenten.
- **Workflow-Orchestrierung (flow-core)**: TF-Orchestrierung mit Schrittzustandsmaschine,
  Vorlagenbibliothek und contextPack, SLA- und Fortschrittsansicht, Gantt-Zeitachse.
- **Model Access Gateway (modelgw)**: echte OpenAI-kompatible Weiterleitung (keine erfundenen Antworten),
  Kanal-Governance mit gestuften Routen, Fallback-Ketten und Budget-Circuit-Breaker.
- **Transparente Nutzungsmessung + FinOps-Bericht**: idempotente Messpipeline, Nullpreis-Snapshot,
  interne Kostenreferenz je Abteilung × Modell (Cost Pass-through), Kosten pro DAU, Ein-Klick-CSV-Export
  (UTF-8-BOM, Excel-freundlich).
- **Execution Hub und digitale Mitarbeiter (Workforce Domain)**: Zielbäume mit Goal Alignment,
  30-Sekunden-Herzschlag-Loop, Ausführungssperren (CAS), Routinen-Planung per Intervall/Cron/Webhook,
  kurzfristige Arbeitsgenehmigungen (Permits) sowie ein Delivery-to-Human-Acceptance-Loop inklusive
  L4-Entsperren-Genehmigung.
- **NAS mit Datenberechtigungen**: Anbindung über ein MCP-Datei-Gateway (keine direkten DSM-Zugriffe),
  RBAC aus Organisationseinheit und Rollenhierarchie mit Default-deny, signierte Download-URLs,
  Ownership-Tracking.
- **Plattform als MCP-Server**: `POST /mcp` stellt über 40 Betriebswerkzeuge jedem MCP-Client bereit
  (z. B. ZCode, Claude, Cursor) — mit Bearer-Token und werkzeuggenauen Permission Points.

## Kommerzielles Modell

YuanBingKe wird nach dem Prinzip **„Team + Domänen-Assets“** angeboten: Die Preisbildung richtet sich nach
der Zahl der aktivierten Teams und den gewählten Domänen-Asset-Paketen (zum Beispiel
Branchen-Wissenspakete oder Szenariopakete) — bewusst nicht als starre Plattform-Pauschale. Für
Unternehmen der Fertigungsindustrie steht eine **private Auslieferung on-premises im Projektmodus**
zur Verfügung.

Die Plattform enthält bewusst keine Abrechnungs- oder Settlement-Semantik: Das integrierte Preisbuch
arbeitet als Nullpreis-Snapshot (Feld `charge` stets 0) und zeigt ausschließlich Nutzungstransparenz
plus interne Beschaffungskosten-Referenz. Wallet-, Guthaben- und Umlagefunktionen sind vollständig aus
dem Produkt entfernt.

## Einsatz und Betrieb

- **Self-hosted, schlanker Stack**: Node ≥ 22.6, nativer TypeScript-Betrieb ohne Build-Schritt;
  Standard-Endpunkt `http://127.0.0.1:7300`.
- **Zwei Installationsformen**: als dsh-Bundle (`dsh plugin --profile web add github:01men/ybkkasi`,
  25 Plugin-Einträge, Datenfläche unter dem Präfix `/rq`) oder eigenständig mit `npm install && npm start`.
- **Demo-Modus für Evaluation**: `DEMO_SEED=1 npm start` befüllt die Instanz mit Demodaten. Nur für
  Demo-Umgebungen vorgesehen — in Produktivumgebungen deaktiviert lassen.
- **Plattform-Selbstupdate**: automatische Versionsprüfung (Standard: alle 24 h, abschaltbar mit
  `DSH_UPDATE_AUTO_CHECK=off`), Upgrade aus der Konsole（控制台）mit Dry-Run und Audit; private Mirrors
  via `DSH_UPDATE_API_BASE` / `DSH_UPDATE_RAW_BASE`. Permission Points: `platform.update.read`,
  `platform.update.apply`.
- **Betrieb und Nachweisführung**: CLI `node cli/dshctl.mjs`, Nutzungsereignisse standardmäßig 730 Tage
  Aufbewahrung (`USAGE_RETENTION_DAYS`), vier Audit-Log-Klassen, CSV-Export für Nutzungs- und
  FinOps-Berichte.
- **Qualitätsgate**: `npm run selftest` führt End-to-End-Tests in einer isolierten Instanz aus
  (über 1.380 Prüfungen, Stand: letzter Lauf).

## Passt das zu DACH?

- **DSGVO und Data Residency durch Selbst-Hosting**: Self-Hosting und private On-Premises-Auslieferung
  sind der Data-Residency-Pfad — die Plattform läuft innerhalb der eigenen Infrastruktur, ohne
  Cloud-Zwang; ein DPA-Prozess ist Roadmap.
- **Passung zur Fertigungsindustrie**: Der Projektmodus für private Auslieferungen ist explizit für
  Fertigungsunternehmen ausgelegt; Execution Hub und digitale Mitarbeiter decken Backoffice- und
  Engineering-Support-Prozesse ab, die NAS-Anbindung passt zu bestehenden Dateiserver-Landschaften
  (z. B. Synology).
- **Nachvollziehbare Governance**: zweistufige Freigaben, Audit-Evidenzanker, L4-Pflichtgenehmigungen
  und Szenen-Autorisierung mit fail-closed unterstützen interne Kontrollsysteme (IKS) und
  revisionssichere Abläufe.

> Ehrlichkeitshinweis: Dies sind Beschreibungen technischer Fähigkeiten und Lieferoptionen, keine
> Zertifizierungen — SOC 2 / ISO 27001 liegen nicht vor (Roadmap). Vor einem Markteintritt im DACH-Raum
> ist eine Compliance-Prüfung durch lokale Rechtsberatung erforderlich; dieses Dokument ist keine
> Rechtsberatung.

## Hinweis zur Sprache der Benutzeroberfläche

Seit dem Release vom 2026-10-16 verfügt die Laufzeit-Oberfläche (Konsole（控制台）, Panel, Portal,
CLI-Ausgaben, Benachrichtigungen, Fehlermeldungen) über einen integrierten Sprachumschalter:
Vereinfachtes Chinesisch (Standard), Englisch (US) und Japanisch. Umschalten über den Sprachselektor
in der Kopfzeile; die Einstellung wird im Browser gespeichert (`rq_lang`). Die CLI folgt `--lang`
oder `DSHCTL_LANG`. Zeichenketten ohne Wörterbucheintrag fallen graceful auf Chinesisch zurück.
Die chinesischen Originalbezeichnungen in Klammern, die in diesen Dokumenten neben den deutschen
Begriffen stehen, bleiben nützlich — etwa für Screenshots, China-feste On-Premises-Installationen
und protokollnahe Beschriftungen; die Browser-Übersetzung funktioniert ebenfalls weiterhin.

## Weiterführende Dokumentation

- [Englische Vollausgabe — Produktübersicht](../en/README.md)
- [Englische Schnelleinstiegs-Anleitung](../en/getting-started.md)
- [Englische Produkteinführung](../en/product-introduction.md)
- [i18n-Governance und Sprachschichten](../README.md)

---

*Diese Übersicht ist eine maschinell unterstützte Tier-2-Zusammenfassung. Bei Abweichungen gilt das chinesische Original; die englische Vollausgabe dient als internationale Referenz.*
