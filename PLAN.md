# AgentControl – suunnitelma

Paikallinen kanban-sovellus, jossa Claude Code -agentit tarkentavat ja toteuttavat tikettejä omissa git worktreissään (päivällä ja yöllä). Ihminen hyväksyy suunnitelman, vastaa kysymyksiin, katselmoi ja mergeää.

Esikuva: "Agent Board: how it's built" -dokumentti (Janne Rautiola, 2026-10-07). Erot esikuvaan: **GitLab korvataan Azure DevOpsilla** (Repos, Pipelines, Boards) ja **stack on kevyempi: Node.js ilman riippuvuuksia** (esikuvassa ASP.NET Core).

## 1. Tavoite ja rajaukset

- Vain oma käyttö, pyörii omalla Windows-koneella, kuuntelee vain 127.0.0.1 ja vaatii satunnaisen tokenin.
- Kaikki ajo `claude`-CLI:n kautta omalla tilauksella. Sovellus ei kutsu Anthropic API:a suoraan.
- Ei tietokantaa: kortit ovat JSON-tiedostoja levyllä.
- Agentit committaavat vain omassa worktreessään. Push, tuotantoajot ja poistot jäävät aina ihmiselle.
- Aloitetaan minimistä (vaiheet 1–4). Lisäosat vasta kun niitä oikeasti tarvitaan.

## 2. Teknologia

| Osa | Valinta | Perustelu |
|---|---|---|
| Palvelin | Node.js 22+, **ei npm-riippuvuuksia** (`http`, `child_process`, `fs`, `fetch`) | Ei build-vaihetta, ei `node_modules`, sama kieli kuin UI:ssa |
| UI | Yksi `index.html` + vanilla JS | Nopea iteroida |
| Live-näkymä | Server-Sent Events | Riittää agentin streamin näyttämiseen, ei kirjastoja |
| Tallennus | `data/cards/<id>/card.json`, `report.md`, `question.md`, `review.md` jne. | Helppo debugata ja varmuuskopioida |
| Käynnistys | Windows Scheduled Task + pieni watchdog | Palautuu kaatumisesta |
| Salaisuudet | Ensisijaisesti `az account get-access-token` (Entra), ei tallennettavaa. Varana PAT salattuna PowerShellin `ProtectedData`(DPAPI)-kutsulla | Node:ssa ei ole sisäänrakennettua DPAPIa |
| Testit | `node:test` + väliaikaiset git-repot + feikki-`claude` | Flow-testit ilman token-kulutusta |

Rakenne:

```
server.js            # HTTP-reitit, token-tarkistus, SSE
lib/cards.js         # korttien luku/kirjoitus, tilakone
lib/claude.js        # claude-CLI:n ajo (retry, resume, stream-json)
lib/dispatcher.js    # WIP-raja, jonotus, riippuvuudet
lib/git.js           # worktree, rebase --onto, squash, siivous
lib/azdo.js          # Azure DevOps REST (PR, pipelines, work items)
public/index.html    # UI
test/                # node:test + feikki-claude
data/                # kortit (gitignore)
```

## 3. Azure DevOps -korvaavuudet (GitLab → Azure DevOps)

Isäntäkohtainen koodi pidetään `lib/azdo.js`-moduulissa, jotta ydin ei tunne Azure DevOpsia: luo PR, hae PR:n tila, squash-complete, poista branch, listaa/käynnistä pipelinet, hae testitulokset ja lokit, hae tiketti.

| GitLab (esikuva) | Azure DevOps | Huomio |
|---|---|---|
| Merge request | Pull request: `POST _apis/git/repositories/{repo}/pullrequests` | Squash completionOptions `mergeStrategy: squash` |
| GitLab-pipeline | Azure Pipelines: `POST _apis/pipelines/{id}/runs` | |
| `spec:inputs` -ajolomake | YAML-pipelinen `parameters:` (runtime parameters) | Lomake generoidaan pipelinen parametrimäärityksestä |
| Child pipelines | Ei suoraa vastinetta. Seurataan triggeröityjä buildejä / pipeline-resursseja | Selvitettävä, miten omat TA/NFT-pipelinet on rakennettu |
| Testiraportit | Test Results API + pipeline-artifaktit | |
| Jira-avain | Azure Boards work item (halutessa edelleen Jira) | |
| Autentikointi | Entra-token (`az login`) tai PAT (Code R/W, Build R/E, Test R, Work Items R) | PAT:t vanhenevat, näytä varoitus UI:ssa |

REST API versio 7.1. Oma ohut `fetch`-kääre. `az devops` -CLI:tä ei tarvita.

## 4. Korttien elinkaari

Inbox → Refining → Ready → Running → Needs input → Review → Done → Archive

- **Inbox**: lyhyt kuvaus, repo(t), prioriteetti, valinnainen "aloita kortin X jälkeen".
- **Refining**: `claude -p --resume <sessio> --output-format stream-json --json-schema <skeema>` palauttaa kysymykset (vaihtoehdot + suositus), suunnitelman ja valmiuden. Ihminen vastaa ja painaa Start work.
- **Ready**: dispatcher käynnistää agentin, kun WIP-paikka on vapaa (4 päivällä, 6 yöllä) ja edeltävät kortit ovat Done.
- **Running**: `claude --bg` kortin omassa worktreessä. Agentti kirjoittaa `report.md`, `question.md`, `followups.json`, `commit-message.txt`.
- **Needs input**: vastaus jatkaa samaa sessiota (`claude -p --resume`).
- **Review**: automaattinen `/code-review` (+ valinnainen `/security-review`), agentti korjaa oikeat löydökset kerran. Ihminen lukee diffin ja squash-mergeää paikallisesti tai pushaa Azure Repos -PR:ää varten.
- **Done → Archive**: kun muutos on originilla, worktree ja branch siivotaan; commitit ja kustannus säilyvät.

## 5. Rakennusjärjestys

Jokainen vaihe on käyttökelpoinen sellaisenaan. Käytä sitä ennen seuraavaa.

**Ydin:**
1. ✅ **Taulu ja kortit**: JSON-kortit, sarakkeet, luontidialogi, token-suojattu API localhostissa.
2. ✅ **Refinement-silmukka**: headless-vuorot JSON-skeemalla, kysymykset ja suunnitelma korttiin, Live-välilehti SSE:llä. Testattu oikealla `claude`:lla.
3. ✅ **Suoritus**: worktree per kortti (`data/worktrees/<kortti>/<repo>`, haara `ac/<kortti>-<slug>`, forkattu `origin/<base>`:sta), `claude --bg`, dispatcher + WIP-raja (4 päivällä / 6 yöllä), tilan seuranta `claude agents --json`-kutsulla, kysymys/vastaus, Stop/Retry. Testattu oikealla agentilla.
4. **Azure DevOps -PR** ✅ (testattu feikki-Azure-palvelimella, ei vielä oikealla organisaatiolla):
   - Review-kortilla nappi "Luo pull request". Se pushaa haaran ja luo PR:n (otsikko `commit-message.txt`:n ensimmäisestä rivistä, kuvaus = loput + `report.md`). Mikään ei lähde koneelta ilman nappia.
   - Remote tunnistetaan `origin`-URL:stä (`dev.azure.com`, `ssh.dev.azure.com`, `*.visualstudio.com`), joten erillistä konfiguraatiota ei tarvita. Yksi PR per repo.
   - Kirjautuminen `az login` -sessiolla (`az account get-access-token`), token välimuistissa.
   - PR:n tilaa seurataan 30 s välein. Kun kaikki PR:t on yhdistetty, kortti siirtyy Done-tilaan ja worktree + paikallinen haara poistetaan. Hylätty PR jättää kortin Review-tilaan.
4b. **Automaattinen katselmointi** ✅ (testattu oikealla `claude`:lla): kun agentti kirjoittaa `report.md`:n, `claude -p "/code-review <taso> <base>"` ajetaan worktreessä vain luku -oikeuksilla (valinnaisesti myös `/security-review`) ja löydökset luetaan `--json-schema`-kentästä. Löydökset menevät samalle agentille kerran (korjauskierros); sen jälkeen kortti siirtyy Review-tilaan. Epäonnistunut katselmointi ei estä korttia. Löydökset näkyvät kortissa ja tiedostossa `review.md`. Asetukset: `AGENTCONTROL_REVIEW` (`off|low|medium|high`, oletus medium), `AGENTCONTROL_SECURITY_REVIEW=1`, `AGENTCONTROL_REVIEW_MODEL/EFFORT`.
   - Havainto: kun löydös on ristiriidassa alkuperäisen tehtävän kanssa, agentti kysyy ihmiseltä (`question.md`) eikä poikkea speksistä omin päin.
   - Kustannus: yksi `/code-review` pienelle muutokselle on noin 0,3–0,85 $.
4c. **Paikallinen squash-merge** ✅ ("Hyväksy työ projektiin"): Review-kortin napilla, kun yksikään repo ei ole Azure DevOpsissa eikä PR:ää ole luotu. Squash-yhdistää agentin haaran repon base-haaraan yhdeksi commitiksi (viesti `commit-message.txt`, ei raporttia), siirtää kortin Doneen ja poistaa worktreen ja haaran; ei pushaa mitään. Vaatii, että repo on base-haarassa ja työkansio siisti (muuten kieltäytyy). Ristiriidassa palauttaa repon ennalleen (`reset --hard` siistiin tilaan). Vanha kärki säilyy refissä `refs/agentcontrol/premerge/<kortti>` perumista varten. Azure DevOps -repoissa PR-reitti pysyy. Vahvistus popupilla; puhekomento "hyväksy työ projektiin".
4d. **Uusi projekti** ✅ (testattu feikki-Claudella ja feikki-GitHubilla, ei vielä oikealla GitHubilla):
   - Sivupalkin nappi luo git-repon repojen juureen (`main`, README, ensimmäinen commit). Olemassa olevaa kansiota ei käytetä eikä poisteta.
   - Lähdekoodin sijainti valitaan luodessa ja näytetään aina projektin näkymässä ja sivupalkissa: **paikallinen** (ei etärepoa) tai **GitHub** (REST: repo luodaan, `origin` asetetaan ja `main` pushataan). Paikallisen projektin voi viedä GitHubiin myöhemmin. Jos GitHub epäonnistuu, paikallinen repo jää ja vaiheen voi yrittää uudelleen tai jatkaa paikallisena.
   - GitHub-token: `AGENTCONTROL_GITHUB_TOKEN`/`GITHUB_TOKEN` → `gh auth token` → Git Credential Manager (`git credential fill`, ilman kehotteita). Mitään ei tallenneta.
   - Kuvauksesta Claude (`-p`, vain luku, `--json-schema`) kirjoittaa suunnitelman ja tehtävät riippuvuuksineen. Muutospyyntö jatkaa samaa sessiota. "Luo kortit" commitoi `PLAN.md`:n mainiin (GitHub-projektissa myös push) ja luo valitut tehtävät Inbox-korteiksi. Ohitetun tehtävän riippuvuus siirtyy eteenpäin.
   - Tila: `data/projects/<nimi>/project.json`. Huom: PR-nappi tukee vielä vain Azure DevOpsia.
4e. **Komentokenttä** ✅: sivun alareunassa, ja se siirtyy avoimen ikkunan alareunaan (modaali lukitsee muun sivun). Kirjoitus ja puhe kulkevat saman reitin läpi: nopeat säännöt (`public/voice.js`) → muuten pieni malli (`/api/voice/interpret`) → `perform()`. Komennot: kaikki puheohjauksen komennot sekä korttien siirto/arkistointi ja projektit (perusta, avaa, kuvaus, muutos, luo kortit, vie GitHubiin). Puuttuvat tiedot kysytään jatkokysymyksinä; seuraava viesti on vastaus ("peruuta" ohittaa). Vastaus pätee vain, jos projekti on yhä samassa vaiheessa. Suunnittelun valmistuminen ilmoitetaan kentässä. Pikanäppäin `/`.
4f. **Ohjaaja (globaali agentti)** ✅ (kokeiltu oikealla Claudella): yksi pysyvä Claude-sessio (`--resume`, `data/orchestrator.json`), joka saa kaikki komennot, joita nopeat säännöt eivät kata. Se ohjaa taulua omalla MCP-palvelimellaan (`lib/board-mcp.js`, `--strict-mcp-config`), joka kutsuu AgentControlin omaa API:a: samat säännöt kuin käyttöliittymässä, ei push/PR/poistoja. Kortit ovat sub-agentteja omilla konteksteillaan; ohjaaja näkee vain kortit. Malli `AGENTCONTROL_ORCHESTRATOR_MODEL` (oletus sonnet, n. 10–25 s ja $0.15–0.20 per viesti). "uusi keskustelu" nollaa muistin.
4g. **Riippuvuuden tyyppi** ✅: `afterKind` = `done` (A toteutettu) tai `planned` (A:n suunnitelma hyväksytty). B:n tarkennus ei käynnisty ennen kuin riippuvuus täyttyy, ellei ihminen vahvista (409 + vahvistus UI:ssa, ohjaajalla NEEDS_CONFIRMATION). Dispatcher noudattaa samaa sääntöä. Projektin suunnittelija merkitsee tyypin; suunnittelu näkyy taululla projektin omana korttina.
4i. **Vahvistukset, projektin poisto, agenttimäärä** ✅: kaikki vahvistukset ovat samaa OK/Peruuta-popupia (tuhoavissa oletusfokus on Peruutassa). Ohjaaja ei kysy vahvistuksia chatissa: työkalun NEEDS_CONFIRMATION-vastaus palautuu sivulle, joka näyttää popupin ja OK:lla tekee toimenpiteen; valinta kerrotaan ohjaajalle seuraavassa viestissä. Projektin poisto projektin ikkunasta: kortit arkistoon, kansio vain erillisellä valinnalla, GitHub-repoon ei kosketa, ei kun agentti on töissä. Sivupalkin projektilista näyttää työssä olevien agenttien määrän (toteutus, käynnissä oleva tarkennus, suunnittelu).
4j. **Sinun vuorosi** ✅: taulun yläreunassa lista siitä, mikä odottaa ihmistä, tärkein ensin (agentti kysyy / pysähtyi → projektin suunnitelma tai kuvaus → tarkentajan kysymykset → valmis suunnitelma hyväksyttäväksi → Review → aloitettavat Inbox-kortit yhtenä rivinä), sekä rivit "Työssä nyt" ja "Odottaa". Kortissa merkki "⚑ <mitä tehdä>". Laskenta `lib/next.js`, `GET /api/next`.
4k. **Worktreen luottamus** ✅ (varmistettu oikealla Claude Code 2.1.306:lla): `claude --bg` kieltäytyy kansiosta, jota ei ole hyväksytty (luottamus ei periydy yläkansiosta). Ennen agentin käynnistystä ja vastauksen jatkoa AgentControl merkitsee vain omat worktree-kansionsa (`data/worktrees/<kortti>/<repo>`) luotetuiksi Claude Coden asetuksiin (`~/.claude.json`, `projects["C:/…"].hasTrustDialogAccepted`). Varmuuskopio `~/.claude.json.agentcontrol-backup` ennen ensimmäistä muutosta, kirjoitus atomisesti. Testit eivät koskaan koske oikeaan tiedostoon (oletuksena pois, `server.js` kytkee päälle).
4l. **Lupakyselyt** ✅: agentit käynnistyvät `--permission-mode auto` -tilassa (Clauden oma tarkistus hyväksyy tavalliset komennot; push/remote/config yhä kielletty; `AGENTCONTROL_AGENT_PERMISSION_MODE` vaihtaa). Kun kysely silti tulee, kortin "Avaa lupakysely" avaa `claude attach <id>` -konsoli-ikkunan työpöydälle (taustaagentin kyselyyn ei voi vastata ohjelmallisesti). Jos tiukemmassa tilassa käynnistetty agentti jää lupakyselyyn, AgentControl pysäyttää sen ja jatkaa samaa sessiota itse auto-tilassa (`--bg --resume <sessio> --permission-mode auto` + samat liput, uusi id), kerran per ajo; sen jälkeen kysely jää ihmiselle. Varmistettu oikealla agentilla. Huom: vastauksen jälkeinen jatko (`--resume` ilman lippuja) pitää session tilan.
4m. **Tapahtumaloki ja pysyvä historia** ✅: kaikki merkittävät tapahtumat (korttien uusi/siirrot, agentin käynnistys/kysymys/lupapyyntö/valmistuminen/pysäytys, tarkennus, katselmointi, projektit, ohjaajan viestit ja vastaukset, PR:t, virheet) kirjataan tiedostoon `data/events.jsonl` (kiertää 5 Mt:n jälkeen) ja näytetään sivupalkin "📜 Tapahtumaloki" -paneelissa reaaliaikaisena SSE-striiminä (`/api/events/stream`, suodatin, klikkaus avaa kortin/projektin). Komentokentän keskustelu tallentuu `data/chat.jsonl`:iin ja palautuu käynnistyksessä. Kortit, projektit, ajot, ohjaajan sessio ja kuvat olivat jo levyllä.
4n. **Projektin malli ja effort** ✅: projektille valitaan kielimalli (`--model`: alias `fable`/`opus`/`sonnet`/`haiku` tai koko mallin nimi) ja effort (`low|medium|high|xhigh|max`) uuden projektin lomakkeella ja myöhemmin projektin ikkunan "Malli ja effort" -osiossa (`POST /api/projects/<nimi>/settings`, tallentuu `project.json`:iin; tyhjä = oletus). Päättely agentille: **kortin oma valinta → projektin valinta → globaali oletus (`AGENTCONTROL_*_MODEL/EFFORT`)**, kumpikin kenttä erikseen. Projekti on kortin ensimmäisen repon projekti. Koskee projektin suunnittelijaa, tarkentajia ja toteutusagentteja (valinta tallentuu ajoon `run.json`:iin, joten jatkettu agentti pitää sen). Automaattinen katselmointi käyttää yhä omaa asetustaan (`AGENTCONTROL_REVIEW_MODEL/EFFORT`). Asetusta ei voi muuttaa kesken suunnittelun. Sivupalkin projektirivillä näkyy valinta. Samalla `writeJsonAtomic` yrittää renamea uudelleen `EPERM`-virheen jälkeen: Windows ei korvaa tiedostoa, jonka lukija pitää hetken auki, ja sivu pollaa näitä tiedostoja.
4h. **Kuvat korteissa** ✅: Ctrl+V liittää kuvan uuden kortin dialogissa ja avatussa kortissa (`data/cards/<id>/attachments`, vain PNG/JPEG/GIF/WebP, tavut tarkistetaan). Tarkentaja ja toteutusagentti saavat kuvien polut tehtävänantoon ja lukuoikeuden.

4o. **Luotettavuus** ✅: (a) yksi instanssi per datakansio: `data/agentcontrol.lock` (pid, `wx`-luonti; kuolleen prosessin lukko otetaan haltuun), toinen `node server.js` päättyy koodiin 75; (b) `scripts/watchdog.js` käynnistää palvelimen uudelleen kaatuessa (backoff 2–60 s, ei uudelleenkäynnistystä koodeilla 0 ja 75) ja `scripts/install-task.ps1` rekisteröi sen Scheduled Taskiksi kirjautumisessa (`-Remove` poistaa); Electron-kuori käynnistää kaatuneen palvelimen uudelleen ja käyttää jo käynnissä olevaa; (c) toistuva sama virhe (esim. `claude agents` rikki) kirjataan tapahtumalokiin kerran ja sitten "(toistui N kertaa)" (10 min ikkuna); (d) olemassa oleva worktree-kansio uudelleenkäytetään vain jos se on kortin oma worktree (git-juuri, oikea haara, sama repo), muuten selkeä virhe; poistettu kansio ei estä uutta (`worktree prune`); (e) `live.jsonl` kiertää 2 Mt:n jälkeen (`live.1.jsonl`) ja arkistoitujen korttien live-lokit poistetaan 30 pv jälkeen (`AGENTCONTROL_ARCHIVE_DAYS`, 0 = ei koskaan; muuta ei poisteta). Testit `test/reliability.test.js`.

4p. **Tokenien käyttö, kertakäyttöinen kirjautuminen, sivun jako** ✅: (a) kaikki kulutus kirjataan tokeneina (ei rahana) tiedostoon `data/usage.jsonl` (`lib/usage.js`): headless-ajojen `result.usage` (tarkennus, suunnittelija, ohjaaja, puhe, katselmointi) ja taustaagenttien kulutus niiden istuntotiedostoista (`~/.claude/projects/<kansio>/<sessio>.jsonl`, luetaan vain lisätty osa, viesti-id kerran). `GET /api/usage` antaa summat päivän, lajin, kortin ja projektin mukaan; näkyy Asetukset-sivulla, yläotsikossa ja kortin tiedoissa. (b) Palvelin tulostaa osoitteen `/?login=<koodi>`: koodi kelpaa kerran ja 10 min; pitkäikäinen token ei jää selainhistoriaan tai terminaaliin (`?token=` toimii yhä). (c) Korttien luku välimuistilla (tiedosto parsitaan vain kun koko tai muokka-aika muuttuu). (d) Epäonnistuneet agentin pysäytykset, worktreen ja haaran poistot sekä `reset --hard` kirjataan tapahtumalokiin. (e) Sivu on jaettu: `public/index.html` (rakenne), `public/style.css` ja `public/js/*.js` (tavallisia skriptejä, jotka jakavat yhden scopen ja latautuvat index.html:n järjestyksessä). (f) Työpöytäkuori ilmoittaa jokaisesta uudesta "Sinun vuorosi" -kohdasta (mitä ja millä kortilla), ei pelkkää lukumäärää.
4q. **Sandbox (projektin ideointi: chat ja piirtoalue)** ✅ (kokeiltu oikealla Claudella): näkymä `#/sandbox`, jokaisella projektilla oma. Keskustelu on oma pysyvä `claude -p` -sessio projektia kohden (`lib/sandbox.js`, malli `AGENTCONTROL_SANDBOX_MODEL`, oletus sonnet), jolla on vain lukutyökalut (Read/Grep/Glob) projektin repoon ja koodikartta ensimmäisessä viestissä; se ei koodaa eikä muuta tiedostoja. Kaikki tallentuu kansioon `data/sandbox/<projekti>/` (`state.json`, `chat.jsonl`, `canvas.json`, `shared/canvas-<n>.png`), joten keskustelu ja piirros säilyvät uudelleenkäynnistyksen yli. Piirros tallentuu vektoreina (koordinaatit 0–1) 800 ms:n viiveellä, mutta tekoäly näkee sen **vain** napista "Näytä piirros tekoälylle": sivu renderöi PNG:n (valkoinen tausta, enintään 1600 px), palvelin tallentaa sen omaksi tiedostokseen ja viesti kertoo polun, jonka tekoäly lukee Read-työkalulla (`--add-dir` sandbox-kansioon); CLI:lle ei välitetä kuvia stdinissä. Näin jokainen jako on käyttäjän päätös ja kustannus pysyy hallinnassa. Korttien ehdotus: sandboxin oma MCP-palvelin (`lib/sandbox-mcp.js`) tarjoaa vain `propose_card`-työkalun, joka ei luo mitään vaan palauttaa aina NEEDS_CONFIRMATION; sivu näyttää OK-popupin, ja vasta OK luo Inbox-kortin (viimeisin jaettu piirros liitteeksi). Lisäksi "Luo kortti" -nappi. Piirto tehdään natiivilla `<canvas>`:lla ja Pointer Eventsillä ilman kirjastoa, koska projektissa ei ole build-vaihetta eikä frontend-riippuvuuksia, ja tarve (kynä, värit, pyyhekumi, kumoa) on pieni. Havainto: modaalisen popupin sulkeuduttua Chrome palauttaa fokuksen tekstikenttään ilman kursoria, joten sivu fokusoi kentän uudelleen vastauksen jälkeen. CLI-havainto (varmistettu): `claude -p --resume <id>` kadonneella sessiolla ei kaadu, vaan päättyy koodilla 0 ja palauttaa result-tapahtuman, jossa `is_error: true` ja `errors: ["No conversation found with session ID: …"]`. Ohjaaja ja sandbox (`lib/session.js`) aloittavat uuden session vain tästä; muu virhe säilyttää session, ja vuoro katkaistaan 10 minuutin jälkeen.

**Valinnainen (vasta tarpeen tullen, järjestys vapaa):**
- Test runs Azure Pipelinesilla
- Work items -haku (Azure Boards / Jira)
- Archive-tilastot (malli · effort vs. lopputulos)
- Schedules + Reports/aamudigest (odotus kun käyttöaste yli 80 % / 5 h tai 90 % / 7 pv)
- Chat omalla MCP-palvelimella

## 6. Opitut asiat esikuvasta, jotka huomioidaan alusta asti

- Älä luota `claude agents` -tilaan "valmis"-tietona. Raportti-tiedoston olemassaolo ratkaisee.
- Käytä `--disallowedTools=mcp__<palvelin>` eikä `--strict-mcp-config`, jotta omat MCP-palvelimet pysyvät käytössä.
- Prosessin käynnistys uudelleenyrityksellä (Claude Coden auto-update lukitsee exen hetkeksi, Win32 216/32/2).
- Squash origin/<base>-haarautumiskohdasta, ei paikallisesta masterista. `rebase --onto`, varmuuskopio-ref ja palautus virheessä.
- Turvalliset uudelleenkäynnistykset: deploy odottaa käynnissä olevat vuorot, katkenneet vuorot jatkavat sessiotaan käynnistyksessä.
- Tausta-päivitys ei saa nollata UI:n scroll-asemaa tai avoimia osioita (ei re-renderiä jos data ei muuttunut).
- Aikojen muotoilu eksplisiittisesti (ei locale-riippuvaista tulostusta suomalaisella koneella).
- Windows: `child_process.spawn` ilman shelliä ja argumentit taulukkona, jotta lainausmerkit eivät riko prompteja.
- Testit feikki-`claude`:lla (esim. skripti, joka kirjoittaa report.md:n).

### `claude --bg` -havainnot (v2.1.266, varmistettu kokeilemalla)

- `claude agents --json --all` listaa myös interaktiiviset sessiot: suodata `kind === 'background'`.
- Tila: `busy/working` = työskentelee, `idle/done` = vuoro ohi (prosessi jää eloon), `waiting/blocked` + `waitingFor` = lupakysely. Heti käynnistyksen jälkeen näkyy hetken `status` puuttuvana ja `state: working`, joten katso molempia kenttiä.
- `--bg` luo oletuksena oman worktreen kun agentti muokkaa tiedostoa repon juuressa. Kun cwd on jo oma worktree, uutta ei luoda.
- Prompt on annettava heti `--bg`:n jälkeen: `--allowedTools` ja `--add-dir` ovat variadic-lippuja ja nielisivät sen.
- Repon ulkopuolelle (korttikansio) kirjoittaminen vaatii `--add-dir` pitkällä (ei 8.3-lyhyellä) polulla, muuten tulee lupakysely.
- Vastaus agentille: `claude stop <id>` ja sitten `claude --bg --resume <sessionId> "viesti"` **ilman lippuja** → sama id ja tallennetut asetukset. Lippujen kanssa tai kesken ajon syntyy kopio uudella id:llä.
- `claude rm` ei poista worktreetä jota se ei itse luonut, ja kieltäytyy poistamasta job-tilaa jos haarassa on pushaamattomia committeja (`--discard-unpushed`).
- Agentti yrittää helposti `cd <polku> && ...` tai `git -C`; ne eivät täsmää sallittuihin komentoihin ja pysäyttävät agentin lupakyselyyn. Prompt kieltää ne.
- Lupakyselyyn jumittunutta agenttia ei voi hyväksyä UI:sta: `claude attach <id>` terminaalissa.

## 7. Riskit ja avoimet kysymykset

- **Azure DevOps Services vai Server?** Oletus: Services (dev.azure.com). Server vaikuttaa API-versioon ja autentikointiin.
- **Autentikointi**: Entra (`az login`) vai PAT? Suositus: Entra jos organisaatio sallii.
- **Branch policyt**: vaativatko PR:t reviewerit/build-validoinnin? Vaikuttaa siihen, mitä "valmis mergettäväksi" tarkoittaa.
- **Pipeline-rakenne**: miten TA/NFT-ajot on rakennettu Azure Pipelinesissa? Määrittää Test runs -sivun.
- **Work items vs. Jira**: kumpi tikettien lähde jatkossa?
- **`claude --bg` / `claude agents`**: varmista omalla koneella, että komennot toimivat odotetusti (versioriippuvaisia) ennen vaihetta 3.
- **Aikataulu**: esikuvassa ~2 päivää yhdeltä kehittäjältä Claude Codella. Vaiheet 1–4 noin 1–2 pv.

## 8. Seuraava askel

Vaihe 1: `package.json` (ei riippuvuuksia, `"type": "module"`), `server.js` + `lib/cards.js`, kortti-JSON-skeema, sarakkeet ja luontidialogi `public/index.html`:ssä.
