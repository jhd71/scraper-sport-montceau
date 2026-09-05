// update-sport.js - Script GitHub Actions pour FC Montceau Bourgogne
// Source: SportCorico
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
// Ce script tourne dans une GitHub Action, jamais dans un navigateur : il
// utilise donc la clé service_role, qui ignore les règles RLS. C'est ce qui
// permet de fermer sport_data au public sans empêcher le scraper d'écrire.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Variables SUPABASE_URL et SUPABASE_SERVICE_KEY requises');
    console.error('   Ajoutez le secret SUPABASE_SERVICE_KEY dans les réglages du dépôt.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SPORTCORICO_URL = 'https://www.sportcorico.com/clubs/fc-montceau-bourgogne/montceau-fc-bourgogn';
const POULE_URL = 'https://www.sportcorico.com/championnat/bourgogne-franche-comte-regional-1-herbelin-4/phase-unique/poule-a';
const COMPETITION = 'REGIONAL 1 HERBELIN';

// ============================================
// CONFIG FFF (source principale)
// L'identifiant d'équipe change chaque saison : le préfixe est
// l'année de DÉBUT de saison (2026 pour 2026/2027). Il est calculé
// automatiquement : à partir de juillet on bascule sur la nouvelle saison.
// ============================================
const crypto = require('crypto');

function saisonFFF() {
    const now = new Date();
    return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; // mois 6 = juillet
}

const FFF_CLUB_SLUG = '500335-f-c-montceau-bourgogne';
const FFF_TEAM_ID = saisonFFF() + '_432_SEM_1'; // ex: 2026_432_SEM_1
const FFF_SITE = 'https://epreuves.fff.fr';
const FFF_PAGE_URL = FFF_SITE + '/competition/club/' + FFF_CLUB_SLUG + '/equipe/' + FFF_TEAM_ID + '/resultat-calendrier';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// La FFF refuse les requêtes venant des serveurs (403, page anti-robot) :
// ni GitHub ni Vercel ne passent. Le relais reste en place au cas où, mais
// la source principale est désormais l'API publique de SportCorico.
const FFF_RELAIS = process.env.FFF_RELAIS_URL || 'https://actuetmedia.fr/api/fff';

// ============================================
// API PUBLIQUE SPORTCORICO (source principale)
// Celle qui alimente les widgets que SportCorico propose aux clubs.
// Elle renvoie du JSON propre, sans clé ni compte, et reste joignable
// depuis GitHub Actions — contrairement à la FFF.
// ============================================
const SC_API = 'https://api.sportcorico.com/api/widgets';
const SC_TEAM_SLUG = 'montceau-fc-bourgogn'; // identifiant de l'équipe fanion

// ============================================
// FETCH HTML
// ============================================
async function fetchHTML(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'fr-FR,fr;q=0.9',
        }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
}

// ============================================
// NETTOYER HTML → TEXTE
// ============================================
function htmlToText(html) {
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:div|p|h[1-6]|li|tr|td|th|a|section|article|header|footer)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x27;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ============================================
// COMPÉTITION (Coupe de France, Régional 1, ...)
// Détecte la compétition dans le texte qui précède les équipes.
// Renvoie un libellé court pour la colonne "matchday" de Supabase,
// ou null si rien de reconnu (le champ sera alors vidé).
// ============================================
function detectCompetition(txt) {
    const t = (txt || '').toUpperCase();
    if (t.includes('COUPE DE FRANCE')) return 'Coupe de France';
    if (t.includes('GAMBARDELLA')) return 'Coupe Gambardella';
    if (t.includes('COUPE DE BOURGOGNE')) return 'Coupe de Bourgogne';
    if (t.includes('COUPE')) return 'Coupe';
    if (t.includes('AMICA')) return 'Amical';
    if (t.includes('REGIONAL 1') || t.includes('RÉGIONAL 1')) return 'Régional 1';
    return null;
}

// ============================================
// EXTRACTION DES NOMS D'ÉQUIPES
// Sur SportCorico, les compétitions sont en MAJUSCULES
// (COUPE DE FRANCE CRÉDIT AGRICOLE..., REGIONAL 1 HERBELIN)
// et les équipes en minuscules/mixte (Bligny 1, Digoin FCa. 1).
// On s'appuie là-dessus pour séparer les deux.
// ============================================

// Un mot peut appartenir à un nom d'équipe s'il contient une minuscule
// ou si c'est un sigle court en majuscules (FC, ASC, UCS...)
function estMotEquipe(t) {
    if (/[a-zà-ÿ]/.test(t)) return true;
    return /^[A-ZÀ-Ü'.()-]+$/.test(t) && t.replace(/[^A-ZÀ-Ü]/g, '').length <= 4;
}

// "... FRANCHE COMTE Bligny 1" -> "Bligny 1" (équipe collée à la FIN du texte)
function extraireEquipeFin(txt) {
    const tokens = txt.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;
    let i = tokens.length - 1;
    if (!/^\d{1,2}$/.test(tokens[i])) return null; // numéro d'équipe (1, 2...)
    const numero = tokens[i];
    i--;
    const nom = [];
    while (i >= 0 && nom.length < 4 && estMotEquipe(tokens[i])) {
        nom.unshift(tokens[i]);
        i--;
    }
    if (nom.length === 0) return null;
    return nom.join(' ') + ' ' + numero;
}

// "Montceau 1 ..." -> "Montceau 1" (équipe au DÉBUT du texte)
function extraireEquipeDebut(txt) {
    const tokens = txt.trim().split(/\s+/).filter(Boolean);
    const nom = [];
    for (let i = 0; i < tokens.length && nom.length < 5; i++) {
        const t = tokens[i];
        if (/^\d{1,2}$/.test(t)) {
            return nom.length ? nom.join(' ') + ' ' + t : null;
        }
        if (!estMotEquipe(t)) return null;
        nom.push(t);
    }
    return null;
}

// Enlève le numéro d'équipe et le mot "Seniors" pour l'affichage
function nettoyerNomEquipe(nom) {
    return nom.replace(/\s*\d+$/, '').replace(/\s*seniors\s*$/i, '').trim();
}

// ============================================
// PARSER DERNIER MATCH + PROCHAIN MATCH
// Fonctionne pour TOUTES les compétitions
// (championnat, Coupe de France, amicaux...)
// ============================================
function parseHeaderMatches(text) {
    const result = { lastMatch: null, nextMatch: null };

    // --- Dernier match : équipe1  date  score1 - score2  équipe2 ---
    const dernierBloc = /Dernier Match\s+([\s\S]*?)(?:Prochain Match|Calendier|Calendrier|Classement)/i.exec(text);
    if (dernierBloc) {
        const block = dernierBloc[1];
        const core = block.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s*-\s*(\d+)/);
        if (core) {
            const avant = block.slice(0, core.index);
            const apres = block.slice(core.index + core[0].length);
            const team1 = extraireEquipeFin(avant);
            const team2 = extraireEquipeDebut(apres);
            if (team1 && team2) {
                const [day, month, year] = core[1].split('/');
                const isHome = team1.toLowerCase().includes('montceau');
                result.lastMatch = {
                    date: `${year}-${month}-${day}`,
                    homeTeam: isHome ? 'FC Montceau' : nettoyerNomEquipe(team1),
                    awayTeam: isHome ? nettoyerNomEquipe(team2) : 'FC Montceau',
                    homeScore: parseInt(core[2]),
                    awayScore: parseInt(core[3]),
                    isHome: isHome,
                    competition: detectCompetition(avant),
                };
            }
        }
    }

    // --- Prochain match : équipe1  date  heure  équipe2 ---
    const prochainBloc = /Prochain Match\s+([\s\S]*?)(?:Calendier|Calendrier|Classement|Comp[ée]titions)/i.exec(text);
    if (prochainBloc) {
        const block = prochainBloc[1];
        const core = block.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2})/);
        if (core) {
            const avant = block.slice(0, core.index);
            const apres = block.slice(core.index + core[0].length);
            const team1 = extraireEquipeFin(avant);
            const team2 = extraireEquipeDebut(apres);
            if (team1 && team2) {
                const [day, month, year] = core[1].split('/');
                const isHome = team1.toLowerCase().includes('montceau');
                result.nextMatch = {
                    date: `${year}-${month}-${day}`,
                    time: core[2],
                    homeTeam: isHome ? 'FC Montceau' : nettoyerNomEquipe(team1),
                    awayTeam: isHome ? nettoyerNomEquipe(team2) : 'FC Montceau',
                    isHome: isHome,
                    competition: detectCompetition(avant),
                };
            }
        }
    }

    return result;
}

// ============================================
// SECOURS : PROCHAIN MATCH DEPUIS LA PAGE DE LA POULE
// Utilisé quand la fiche du club n'affiche pas de match R1
// (intersaison : elle ne montre que des amicaux)
// ============================================
async function parseProchainDepuisPoule() {
    const html = await fetchHTML(POULE_URL);
    const text = htmlToText(html);

    const aujourdhui = new Intl.DateTimeFormat('fr-CA', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());

    const regex = /([\w\s'.()-]+?\d)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+([\w\s'.()-]+?\d)/g;
    let m, meilleur = null;

    while ((m = regex.exec(text)) !== null) {
        const [, team1, dateStr, time, team2] = m;
        const t1 = team1.trim();
        const t2 = team2.trim();

        if (!t1.toLowerCase().includes('montceau') && !t2.toLowerCase().includes('montceau')) continue;

        const [day, month, year] = dateStr.split('/');
        const date = `${year}-${month}-${day}`;

        if (date < aujourdhui) continue;           // match déjà passé
        if (meilleur && meilleur.date <= date) continue; // on garde le plus proche

        const isHome = t1.toLowerCase().includes('montceau');
        meilleur = {
            date: date,
            time: time,
            homeTeam: isHome ? 'FC Montceau' : nettoyerNomEquipe(t1),
            awayTeam: isHome ? nettoyerNomEquipe(t2) : 'FC Montceau',
            isHome: isHome,
        };
    }

    return meilleur;
}

// ============================================
// SECOURS : RÉSULTATS DEPUIS LA PAGE DE LA POULE
// La fiche club de SportCorico met parfois plusieurs heures à afficher le
// score (elle montre encore l'heure du coup d'envoi), alors que la page de
// la poule, elle, est à jour le soir même. On y récupère donc les matchs
// de Montceau qui ont un score.
// ============================================
async function parseResultatsDepuisPoule() {
    const html = await fetchHTML(POULE_URL);
    const text = htmlToText(html);

    const aujourdhui = new Intl.DateTimeFormat('fr-CA', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());

    const resultats = [];
    // On repère "date score - score" puis on lit les équipes de part et
    // d'autre avec les mêmes helpers que la fiche club (robustes aux
    // encarts publicitaires glissés entre les matchs)
    const noyau = /(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s*-\s*(\d+)/g;
    let m;
    while ((m = noyau.exec(text)) !== null) {
        const avant = text.slice(0, m.index);
        const apres = text.slice(m.index + m[0].length);
        const t1 = extraireEquipeFin(avant);
        const t2 = extraireEquipeDebut(apres);
        if (!t1 || !t2) continue;
        if (!t1.toLowerCase().includes('montceau') && !t2.toLowerCase().includes('montceau')) continue;

        const [jour, mois, annee] = m[1].split('/');
        const date = `${annee}-${mois}-${jour}`;
        if (date > aujourdhui) continue; // pas un match déjà joué

        const isHome = t1.toLowerCase().includes('montceau');
        resultats.push({
            date: date,
            homeTeam: isHome ? 'FC Montceau' : nettoyerNomEquipe(t1),
            awayTeam: isHome ? nettoyerNomEquipe(t2) : 'FC Montceau',
            homeScore: parseInt(m[2]),
            awayScore: parseInt(m[3]),
            isHome: isHome,
        });
    }

    resultats.sort((a, b) => a.date.localeCompare(b.date));
    return resultats;
}

// ============================================
// PARSER TOUS LES MATCHS DE CHAMPIONNAT
// ============================================
function parseChampionnatResults(text) {
    const results = [];
    const matchRegex = /REGIONAL 1 HERBELIN\s+([\w\s'.()-]+?\d)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s*-\s*(\d+)\s+([\w\s'.()-]+?\d)/g;

    let m;
    while ((m = matchRegex.exec(text)) !== null) {
        const [, team1, dateStr, s1, s2, team2] = m;
        const t1 = team1.trim();
        const t2 = team2.trim();

        if (!t1.toLowerCase().includes('montceau') && !t2.toLowerCase().includes('montceau')) continue;

        const [day, month, year] = dateStr.split('/');
        const isHome = t1.toLowerCase().includes('montceau');

        results.push({
            date: `${year}-${month}-${day}`,
            homeTeam: t1,
            awayTeam: t2,
            homeScore: parseInt(s1),
            awayScore: parseInt(s2),
            isHome: isHome,
        });
    }

    return results;
}

// ============================================
// FORME DEPUIS RÉSULTATS
// ============================================
function parseForm(text) {
    const formMatch = text.match(/Football\s+([VDN](?:\s+[VDN]){1,9})\s/i);
    if (formMatch) {
        const letters = formMatch[1].match(/[VDN]/gi);
        if (letters && letters.length >= 2) {
            return letters.map(l => l.toUpperCase()).join(',');
        }
    }
    return null;
}

function computeStats(results) {
    let played = 0, won = 0, drawn = 0, lost = 0, goalsFor = 0, goalsAgainst = 0;
    for (const r of results) {
        played++;
        const fcmb = r.isHome ? r.homeScore : r.awayScore;
        const opp = r.isHome ? r.awayScore : r.homeScore;
        goalsFor += fcmb;
        goalsAgainst += opp;
        if (fcmb > opp) won++;
        else if (fcmb < opp) lost++;
        else drawn++;
    }
    return { played, won, drawn, lost, points: won * 3 + drawn, goalsFor, goalsAgainst };
}

function computeFormFromResults(results) {
    const sorted = [...results].sort((a, b) => a.date.localeCompare(b.date));
    return sorted.slice(-5).map(r => {
        const fcmb = r.isHome ? r.homeScore : r.awayScore;
        const opp = r.isHome ? r.awayScore : r.homeScore;
        return fcmb > opp ? 'V' : fcmb < opp ? 'D' : 'N';
    }).join(',');
}

// ============================================
// SOURCE PRINCIPALE : API WIDGETS SPORTCORICO
// ============================================

async function scApi(chemin) {
    const res = await fetch(SC_API + chemin, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json || json.success === false) {
        throw new Error((json && json.message) || 'réponse invalide');
    }
    return json;
}

// "05/09/2026" -> "2026-09-05"
function dateFR(txt) {
    const m = String(txt || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? m[3] + '-' + m[2] + '-' + m[1] : null;
}

// Libellé affiché sur la carte : "Journée 1", "Coupe de France", "Amical"
function libelleSC(m) {
    const comp = String(m.championship_name || '').toUpperCase();
    if (comp.includes('COUPE DE FRANCE')) return 'Coupe de France';
    if (comp.includes('GAMBARDELLA')) return 'Coupe Gambardella';
    if (comp.includes('COUPE')) return 'Coupe';
    if (comp.includes('AMICA')) return 'Amical';
    return m.day || 'Régional 1'; // "Journée 1" pour le championnat
}

function equipeSC(nomCourt, slug) {
    return (slug === SC_TEAM_SLUG) ? 'FC Montceau' : nettoyerNomEquipe(nomCourt || '');
}

// Parmi les classements renvoyés (l'API donne aussi les saisons passées),
// retenir celui de la saison EN COURS : une saison terminée a autant de
// journées jouées que le maximum possible, (nb équipes - 1) x 2.
function pouleEnCours(pools) {
    const avecMontceau = (pools || []).filter(function(p) {
        return (p.lines || []).some(function(l) { return /montceau/i.test(l.team || ''); });
    });
    if (avecMontceau.length === 0) return null;

    const enCours = avecMontceau.filter(function(p) {
        const nb = (p.lines || []).length;
        const ligne = p.lines.find(function(l) { return /montceau/i.test(l.team || ''); });
        return ligne && Number(ligne.games_played) < (nb - 1) * 2;
    });

    const liste = enCours.length > 0 ? enCours : avecMontceau;
    return liste[liste.length - 1]; // la plus récente
}

async function scrapeSportCoricoAPI() {
    console.log('⚽ Lecture de l\'API SportCorico...');
    const updateData = {};
    const logs = [];

    // --- Dernier et prochain match ---
    const matchs = await scApi('/next-previous-team-game/' + SC_TEAM_SLUG);

    const precedent = matchs.previous_match;
    if (precedent && dateFR(precedent.planned_date)) {
        const isHome = precedent.home_team_slug === SC_TEAM_SLUG;
        updateData.last_match_date = dateFR(precedent.planned_date);
        updateData.last_match_home_team = equipeSC(precedent.home_team_short_name, precedent.home_team_slug);
        updateData.last_match_away_team = equipeSC(precedent.outside_team_short_name, precedent.outside_team_slug);
        updateData.last_match_home_score = Number(precedent.home_score) || 0;
        updateData.last_match_away_score = Number(precedent.outside_score) || 0;
        updateData.last_match_is_home = isHome;
        updateData.last_match_matchday = libelleSC(precedent);
        logs.push('✅ Dernier match: ' + updateData.last_match_home_team + ' '
            + updateData.last_match_home_score + '-' + updateData.last_match_away_score + ' '
            + updateData.last_match_away_team + ' (' + updateData.last_match_matchday + ')');
    } else {
        logs.push('ℹ️ Aucun match joué renvoyé par l\'API');
    }

    const suivant = matchs.next_match;
    if (suivant && dateFR(suivant.planned_date)) {
        updateData.next_match_date = dateFR(suivant.planned_date);
        updateData.next_match_time = suivant.planned_time || '';
        updateData.next_match_home_team = equipeSC(suivant.home_team_short_name, suivant.home_team_slug);
        updateData.next_match_away_team = equipeSC(suivant.outside_team_short_name, suivant.outside_team_slug);
        updateData.next_match_is_home = suivant.home_team_slug === SC_TEAM_SLUG;
        updateData.next_match_matchday = libelleSC(suivant);
        logs.push('✅ Prochain match: ' + updateData.next_match_home_team + ' vs '
            + updateData.next_match_away_team + ' le ' + updateData.next_match_date
            + ' à ' + updateData.next_match_time + ' (' + updateData.next_match_matchday + ')');
    } else {
        logs.push('ℹ️ Aucun match à venir renvoyé par l\'API');
    }

    // --- Classement de la poule ---
    let poule = null;
    try {
        const classements = await scApi('/team-rankings/' + SC_TEAM_SLUG);
        poule = pouleEnCours(classements.ranking_pools);
    } catch (e) {
        logs.push('⚠️ Classement: ' + String(e.message).slice(0, 60));
    }

    if (poule) {
        const lignes = (poule.lines || []).map(function(l) {
            return {
                position: Number(l.rank),
                team: nettoyerNomEquipe(l.team || ''),
                points: Number(l.points),
                played: Number(l.games_played),
                won: Number(l.won),
                drawn: Number(l.nulls),
                lost: Number(l.lost),
                goalsFor: Number(l.scored),
                goalsAgainst: Number(l.conceded),
                diff: Number(l.difference),
            };
        }).filter(function(l) { return l.position && l.team; });

        const fcmb = lignes.find(function(l) { return /montceau/i.test(l.team); });

        if (fcmb && fcmb.played > 0) {
            updateData.standings_json = lignes;
            updateData.standing_position = fcmb.position;
            updateData.standing_points = fcmb.points;
            updateData.standing_played = fcmb.played;
            updateData.standing_won = fcmb.won;
            updateData.standing_drawn = fcmb.drawn;
            updateData.standing_lost = fcmb.lost;
            updateData.standing_goals_for = fcmb.goalsFor;
            updateData.standing_goals_against = fcmb.goalsAgainst;
            logs.push('🏆 Classement (' + poule.label + '): ' + lignes.length
                + ' équipes, FCMB ' + fcmb.position + 'e avec ' + fcmb.points + ' pts');
        } else {
            // Championnat pas encore commencé : on efface le classement de la
            // saison précédente resté en base plutôt que d'afficher du périmé
            updateData.standings_json = null;
            updateData.standing_position = null;
            updateData.standing_points = null;
            updateData.standing_played = null;
            updateData.standing_won = null;
            updateData.standing_drawn = null;
            updateData.standing_lost = null;
            updateData.standing_goals_for = null;
            updateData.standing_goals_against = null;
            logs.push('🧹 Championnat pas encore commencé : ancien classement effacé');
        }

        // --- Forme : les 5 derniers résultats, fournis par l'API ---
        const ligneBrute = (poule.lines || []).find(function(l) { return /montceau/i.test(l.team || ''); });
        const forme = ligneBrute && ligneBrute.shape_of_the_moment;
        if (Array.isArray(forme) && forme.length > 0) {
            updateData.form = forme.map(function(f) { return String(f).toUpperCase(); }).join(',');
            logs.push('✅ Forme: ' + updateData.form);
        }
    }

    if (Object.keys(updateData).length === 0) throw new Error('API SportCorico: rien à mettre à jour');
    return { updateData: updateData, logs: logs };
}

// ============================================
// SOURCE FFF — API officielle derrière epreuves.fff.fr
//
// Fonctionnement (découvert le 30/08/2026) :
// 1. La page HTML de l'équipe contient un jeton : "VLJAXE":"xxxx"
// 2. Chaque appel API doit envoyer l'en-tête X-Competition qui vaut
//    SHA1(`${jeton}-${Math.floor(Date.now()/10000)}`) en hexadécimal
// 3. L'API renvoie du JSON propre (matchs, compétitions, classement)
// ============================================

function sha1hex(str) {
    return crypto.createHash('sha1').update(str).digest('hex');
}

function cookiesDe(res) {
    if (typeof res.headers.getSetCookie === 'function') {
        return res.headers.getSetCookie().map(c => c.split(';')[0]);
    }
    return [];
}

async function fffApi(session, path) {
    const hash = sha1hex(session.token + '-' + Math.floor(Date.now() / 10000));
    const headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'X-Competition': hash,
        'Referer': FFF_PAGE_URL,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
    };
    if (session.cookies) headers['Cookie'] = session.cookies;
    const res = await fetch(FFF_SITE + path, { headers: headers });
    if (!res.ok) {
        const corps = await res.text().catch(function() { return ''; });
        throw new Error('API FFF ' + path.split('?')[0] + ': HTTP ' + res.status + (corps ? ' — ' + corps.slice(0, 200) : ''));
    }
    return res.json();
}

// La FFF renvoie les noms tout en majuscules. On les remet en forme :
// "AS CHATENOY LE ROYAL" -> "AS Chatenoy le Royal", "DIGOIN F.C.A." inchangé
const SIGLES_CLUBS = new Set(['AS', 'ASA', 'ASC', 'AJ', 'AC', 'CA', 'CO', 'CS', 'EA', 'EF',
    'ES', 'FC', 'FCA', 'FCMB', 'GJ', 'JS', 'OL', 'OM', 'RC', 'SA', 'SC', 'SM', 'UCS', 'UF', 'US']);
const PETITS_MOTS = new Set(['le', 'la', 'les', 'de', 'du', 'des', 'sur', 'et', 'en', 'aux', 'au', 'sous']);

function joliNom(nom) {
    return String(nom || '').trim().split(/\s+/).map(function(mot, i) {
        if (mot.includes('.')) return mot; // sigle ponctué : F.C.A., Ent.F.
        if (SIGLES_CLUBS.has(mot.toUpperCase())) return mot.toUpperCase();
        const bas = mot.toLowerCase();
        if (i > 0 && PETITS_MOTS.has(bas)) return bas;
        return bas.charAt(0).toUpperCase() + bas.slice(1);
    }).join(' ');
}

// Libellé court de compétition pour la carte du widget
function libelleFFF(m) {
    const nom = (m.competitionNom || '').toUpperCase();
    if (nom.includes('COUPE DE FRANCE')) return 'Coupe de France';
    if (nom.includes('GAMBARDELLA')) return 'Coupe Gambardella';
    if (nom.includes('AMICA')) return 'Amical';
    if (m.competitionType === 'Coupe') return 'Coupe';
    if (m.competitionType === 'Championnat') return m.journee ? 'Journée ' + m.journee : 'Régional 1';
    return null;
}

// Transforme un match brut de l'API en objet simple
function mapMatchFFF(x) {
    const d = x.donneesFormatees || {};
    const comp = (d.competition && d.competition.donneesFormatees) || {};
    const recevant = d.recevant || {};
    const visiteur = d.visiteur || {};
    const isHome = !!(recevant.equipe && recevant.equipe.id === FFF_TEAM_ID);
    return {
        date: d.date || '',                       // ISO avec heure, ex 2026-08-30T15:00:00+02:00
        dateJour: (d.date || '').slice(0, 10),    // YYYY-MM-DD
        heure: (d.date || '').slice(11, 16),      // HH:MM
        joue: !!d.joue,
        competitionNom: comp.nom || '',
        competitionType: comp.type || '',          // Championnat / Coupe / Autre
        journee: (d.journee && d.journee.pjNo) || '',
        homeTeam: isHome ? 'FC Montceau' : joliNom(recevant.club && recevant.club.nom),
        awayTeam: isHome ? joliNom(visiteur.club && visiteur.club.nom) : 'FC Montceau',
        homeScore: (recevant.buts != null) ? recevant.buts : 0,
        awayScore: (visiteur.buts != null) ? visiteur.buts : 0,
        isHome: isHome,
        resuFCMB: isHome ? (recevant.resu || '') : (visiteur.resu || ''), // GA gagné / PE perdu / NU nul
        urlClassement: (d.groupe && d.groupe.urlClassement) || null,
        // De quoi reconstruire l'adresse de la page publique du classement :
        // /competition/engagement/<slug>/phase/<phNo>/<gpNo>
        competitionSlug: comp.slug || '',
        phNo: (d.phase && d.phase.phNo) || '',
        gpNo: (d.groupe && d.groupe.gpNo) || '',
    };
}

// Format réel d'une ligne de classement FFF (relevé le 05/09/2026) :
// { placeAffichage:"2", nomEquipe:"MONTCEAU", classement:"2", points:"3",
//   nbMatch:"1", nbMatchGagne:"1", nbMatchNul:"0", nbMatchPe:"0",
//   nbButPour:"3", nbButContre:"1", diffBut:"2", serieEnCours:["V"] }
// Toutes les valeurs sont des CHAÎNES : d'où le parseInt systématique.
function normaliserEntreeClassement(e) {
    function num(v) {
        const n = parseInt(v, 10);
        return isNaN(n) ? null : n;
    }
    return {
        position: num(e.placeAffichage != null && e.placeAffichage !== '' ? e.placeAffichage : e.classement),
        team: e.nomEquipe || e.nomEquipeAbr || '',
        points: num(e.points),
        played: num(e.nbMatch),
        won: num(e.nbMatchGagne),
        drawn: num(e.nbMatchNul),
        lost: num(e.nbMatchPe),
        goalsFor: num(e.nbButPour),
        goalsAgainst: num(e.nbButContre),
        diff: num(e.diffBut),
    };
}

// La réponse "classement" enveloppe le tableau des équipes dans
// hydra:member[0].donneesFormatees. Cette fonction le déballe, quelle
// que soit la voie utilisée (page HTML ou API).
function equipesDuClassement(body) {
    const out = [];
    for (const item of (body && body['hydra:member']) || []) {
        const df = item && item.donneesFormatees;
        if (Array.isArray(df)) out.push.apply(out, df);
        else if (df && df.nomEquipe) out.push(df);
        else if (item && item.nomEquipe) out.push(item);
    }
    return out;
}

function dateParamFFF(d) {
    return d.toISOString().slice(0, 10) + 'T00:00:00%2B00:00';
}

// ============================================
// PLAN B FFF : lire les données incluses dans le HTML des pages.
// L'API directe est bloquée depuis GitHub Actions (403), mais les pages
// HTML, elles, se téléchargent sans problème — et elles contiennent un
// bloc <script id="ng-state"> avec les réponses API déjà incluses.
// Particularité : chaque lecture de la page matchs n'inclut AU HASARD
// qu'un seul des deux mois pré-chargés (mois en cours / mois suivant),
// donc on lit la page plusieurs fois et on fusionne les matchs.
// ============================================

function extraireNgState(html) {
    const m = html.match(/<script id="ng-state" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// Demande au relais du site les données d'une page FFF.
// Renvoie le même objet que le ng-state, filtré aux matchs et au classement.
async function fffEtatViaRelais(chemin) {
    const res = await fetch(FFF_RELAIS + '?path=' + encodeURIComponent(chemin), {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    });
    const corps = await res.json().catch(function() { return null; });
    if (!res.ok || !corps || !corps.state) {
        const detail = corps && (corps.error || corps.extrait) ? ' — ' + String(corps.error || corps.extrait).slice(0, 80) : '';
        throw new Error('relais HTTP ' + res.status + detail);
    }
    return corps.state;
}

// Récupère l'état d'une page FFF : lecture directe d'abord (elle marche
// depuis un poste normal), relais du site ensuite (indispensable depuis
// GitHub Actions). Renvoie { etat, via }.
async function fffEtatPage(chemin) {
    let diagDirect = '';
    try {
        const res = await fetch(FFF_SITE + chemin, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Accept-Language': 'fr-FR,fr;q=0.9' }
        });
        const html = await res.text();
        const etat = extraireNgState(html);
        if (etat) return { etat: etat, via: 'direct', diag: 'HTTP ' + res.status + ', ' + Math.round(html.length / 1024) + ' Ko' };
        diagDirect = 'HTTP ' + res.status + ', ' + Math.round(html.length / 1024) + ' Ko, ng-state NON';
    } catch (e) {
        diagDirect = 'erreur réseau: ' + String(e.message).slice(0, 50);
    }

    const etat = await fffEtatViaRelais(chemin);
    return { etat: etat, via: 'relais', diag: 'direct refusé (' + diagDirect + '), relais OK' };
}

function pause(ms) {
    return new Promise(function(r) { setTimeout(r, ms); });
}

// Extrait tous les matchs présents dans le ng-state d'une page
function matchsDuNgState(state) {
    const parId = new Map();
    let blocs = 0;
    for (const cle of Object.keys(state || {})) {
        if (!cle.startsWith('analog_GET|') || !cle.includes('/api/data/matches')) continue;
        blocs++;
        const body = state[cle] && state[cle].body;
        for (const x of (body && body['hydra:member']) || []) {
            if (x && x['@id']) parId.set(x['@id'], x);
        }
    }
    return { membres: Array.from(parId.values()), blocs: blocs };
}

// UNE seule lecture de la page de l'équipe suffit : son ng-state contient
// désormais les matchs de TOUS les mois pré-chargés (clés distinctes par
// mois), plus le jeton de sécurité. On évite ainsi de marteler le site,
// ce qui avait probablement déclenché un blocage anti-robot.
// Deuxième essai (avec anti-cache) seulement si le premier est inexploitable.
async function fffLirePageEquipe() {
    const chemin = '/competition/club/' + FFF_CLUB_SLUG + '/equipe/' + FFF_TEAM_ID + '/resultat-calendrier';

    // Jeton de sécurité : seule la lecture directe peut le fournir, et il ne
    // sert qu'à tenter l'API (bloquée depuis GitHub). Facultatif donc.
    let token = null;
    let cookies = '';

    try {
        const r = await fetch(FFF_SITE + chemin, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Accept-Language': 'fr-FR,fr;q=0.9' }
        });
        const html = await r.text();
        const etat = extraireNgState(html);
        const mTok = html.match(/"VLJAXE":"([^"]+)"/);
        if (mTok) { token = mTok[1]; cookies = cookiesDe(r).join('; '); }

        if (etat) {
            const trouve = matchsDuNgState(etat);
            const diag = 'lecture directe — HTTP ' + r.status + ', ' + Math.round(html.length / 1024) + ' Ko, '
                + trouve.blocs + ' bloc(s), ' + trouve.membres.length + ' match(s)';
            console.log('  🌐 ' + diag);
            return { membres: trouve.membres, token: token, cookies: cookies, diag: diag };
        }
        console.log('  🌐 FFF directe refusée (HTTP ' + r.status + ', ' + Math.round(html.length / 1024) + ' Ko, pas de ng-state) — passage par le relais');
    } catch (e) {
        console.log('  🌐 FFF directe impossible (' + String(e.message).slice(0, 60) + ') — passage par le relais');
    }

    // Relais du site : c'est la voie qui fonctionne depuis GitHub Actions
    try {
        const etat = await fffEtatViaRelais(chemin);
        const trouve = matchsDuNgState(etat);
        const diag = 'via le relais du site — ' + trouve.blocs + ' bloc(s), ' + trouve.membres.length + ' match(s)';
        console.log('  🔁 ' + diag);
        return { membres: trouve.membres, token: token, cookies: cookies, diag: diag };
    } catch (e) {
        const diag = 'relais en échec : ' + String(e.message).slice(0, 120);
        console.log('  ❌ ' + diag);
        return { membres: [], token: token, cookies: cookies, diag: diag };
    }
}

// Classement complet : la page publique de la poule
// (/competition/engagement/<slug>/phase/<phNo>/<gpNo>) inclut le tableau
// dans son ng-state — donc accessible sans l'API, qui elle est bloquée.
async function fffClassementDepuisPage(match) {
    if (!match || !match.competitionSlug || !match.phNo || !match.gpNo) return null;
    const chemin = '/competition/engagement/' + match.competitionSlug
        + '/phase/' + match.phNo + '/' + match.gpNo;

    const res = await fffEtatPage(chemin); // direct, puis relais
    const state = res.etat;
    if (!state) return null;
    for (const cle of Object.keys(state)) {
        if (!cle.startsWith('analog_GET|') || !cle.toLowerCase().includes('classement')) continue;
        const equipes = equipesDuClassement(state[cle] && state[cle].body);
        if (equipes.length > 0) {
            console.log('  🏆 Classement lu ' + (res.via === 'relais' ? 'via le relais' : 'en direct') + ' (' + equipes.length + ' équipes)');
            return equipes;
        }
    }
    return null;
}

async function scrapeFFF() {
    const updateData = {};
    const logs = [];

    let apiOk = false;

    // 1. UNE lecture de la page de l'équipe : elle fournit d'un coup les
    //    matchs (ng-state) ET le jeton de sécurité pour tenter l'API.
    const page = await fffLirePageEquipe();
    logs.push('🌐 Page équipe: ' + page.diag);
    let membres = page.membres;

    // 2. Bonus : si l'API répond (elle est bloquée depuis GitHub Actions),
    //    elle donne une fenêtre plus large (±120 jours) que la page.
    if (page.token) {
        try {
            const session = { token: page.token, cookies: page.cookies };
            const debut = new Date(Date.now() - 120 * 24 * 3600 * 1000);
            const fin = new Date(Date.now() + 120 * 24 * 3600 * 1000);
            const data = await fffApi(session, '/api/data/matches?idEquipe=' + FFF_TEAM_ID
                + '&dateDebut=' + dateParamFFF(debut) + '&dateFin=' + dateParamFFF(fin)
                + '&itemsPerPage=100&pagination=true');
            const viaApi = data['hydra:member'] || [];
            if (viaApi.length >= membres.length) {
                membres = viaApi;
                apiOk = true;
                logs.push('✅ FFF (API directe): ' + membres.length + ' matchs');
            }
        } catch (e) {
            logs.push('ℹ️ API FFF indisponible (' + String(e.message).slice(0, 50) + ') — on garde les données de la page');
        }
    }

    if (membres.length > 0 && !apiOk) {
        logs.push('✅ FFF (page HTML): ' + membres.length + ' matchs');
    }

    const matchs = membres.map(mapMatchFFF)
        .filter(function(m) { return m.dateJour; })
        .sort(function(a, b) { return a.date.localeCompare(b.date); });
    if (matchs.length === 0) {
        // On attache les logs à l'erreur : sans ça, tout le diagnostic
        // était perdu et le journal GitHub n'affichait qu'un message vague
        const err = new Error('FFF: aucun match trouvé');
        err.logs = logs;
        throw err;
    }

    const maintenant = new Date().toISOString();
    const joues = matchs.filter(function(m) { return m.joue; });
    const aVenir = matchs.filter(function(m) { return !m.joue && m.date >= maintenant; });

    // --- Dernier match joué (toutes compétitions : coupe comprise) ---
    if (joues.length > 0) {
        const dernier = joues[joues.length - 1];
        updateData.last_match_date = dernier.dateJour;
        updateData.last_match_home_team = dernier.homeTeam;
        updateData.last_match_away_team = dernier.awayTeam;
        updateData.last_match_home_score = dernier.homeScore;
        updateData.last_match_away_score = dernier.awayScore;
        updateData.last_match_is_home = dernier.isHome;
        updateData.last_match_matchday = libelleFFF(dernier);
        logs.push('✅ Dernier match: ' + dernier.homeTeam + ' ' + dernier.homeScore + '-' + dernier.awayScore + ' ' + dernier.awayTeam + ' (' + (updateData.last_match_matchday || '?') + ')');
    }

    // --- Prochain match ---
    if (aVenir.length > 0) {
        const prochain = aVenir[0];
        updateData.next_match_date = prochain.dateJour;
        updateData.next_match_time = prochain.heure;
        updateData.next_match_home_team = prochain.homeTeam;
        updateData.next_match_away_team = prochain.awayTeam;
        updateData.next_match_is_home = prochain.isHome;
        updateData.next_match_matchday = libelleFFF(prochain);
        logs.push('✅ Prochain match: ' + prochain.homeTeam + ' vs ' + prochain.awayTeam + ' le ' + prochain.dateJour + ' à ' + prochain.heure + ' (' + (updateData.next_match_matchday || '?') + ')');
    }

    // --- Forme : 5 derniers matchs joués (toutes compétitions) ---
    // La page ne couvre que quelques mois : avec moins de 2 matchs connus
    // on garde la forme déjà en base plutôt que de l'écraser par une seule lettre
    if (joues.length > 0 && (apiOk || joues.length >= 2)) {
        updateData.form = joues.slice(-5).map(function(m) {
            if (m.resuFCMB === 'GA') return 'V';
            if (m.resuFCMB === 'PE') return 'D';
            if (m.resuFCMB === 'NU') return 'N';
            const fcmb = m.isHome ? m.homeScore : m.awayScore;
            const opp = m.isHome ? m.awayScore : m.homeScore;
            return fcmb > opp ? 'V' : (fcmb < opp ? 'D' : 'N');
        }).join(',');
        logs.push('✅ Forme: ' + updateData.form);
    }

    // --- Stats championnat (matchs R1 joués uniquement) ---
    const matchsR1 = joues.filter(function(m) { return m.competitionType === 'Championnat'; });
    const moisActuel = new Date().getMonth(); // 6=juillet, 7=août, 8=septembre
    if (matchsR1.length === 0 && moisActuel >= 6 && moisActuel <= 8) {
        // Nouvelle saison, championnat pas commencé : on efface le classement
        // de la saison précédente resté dans Supabase (sinon le site affiche
        // par ex. "6e · 32 pts · 23J" qui date de l'an dernier).
        // Si le classement FFF existe déjà, il est rempli juste en dessous.
        updateData.standing_position = null;
        updateData.standings_json = null;
        updateData.standing_points = null;
        updateData.standing_played = null;
        updateData.standing_won = null;
        updateData.standing_drawn = null;
        updateData.standing_lost = null;
        updateData.standing_goals_for = null;
        updateData.standing_goals_against = null;
        logs.push('🧹 Championnat pas commencé : classement de la saison précédente effacé');
    }
    if (matchsR1.length > 0) {
        const stats = computeStats(matchsR1);
        updateData.standing_played = stats.played;
        updateData.standing_won = stats.won;
        updateData.standing_drawn = stats.drawn;
        updateData.standing_lost = stats.lost;
        updateData.standing_points = stats.points;
        updateData.standing_goals_for = stats.goalsFor;
        updateData.standing_goals_against = stats.goalsAgainst;
        logs.push('✅ Stats R1: ' + stats.points + 'pts, ' + stats.played + 'J');
    }

    // --- Classement complet de la poule ---
    // Voie principale : la page publique de la poule, dont le ng-state
    // contient le tableau complet (l'API, elle, est bloquée depuis GitHub).
    // N'importe quel match de championnat suffit : on n'a besoin que de son
    // identifiant de poule pour construire l'adresse de la page classement
    const matchsChampionnat = matchs.filter(function(m) { return m.competitionType === 'Championnat'; });
    const matchAvecClassement = matchsR1[matchsR1.length - 1] || matchsChampionnat[0];
    let entreesBrutes = null;
    if (matchAvecClassement) {
        try {
            await pause(1500); // on espace les requêtes vers la FFF
            entreesBrutes = await fffClassementDepuisPage(matchAvecClassement);
        } catch (e) {
            logs.push('⚠️ Classement (page poule): ' + String(e.message).slice(0, 60));
        }
        if (!entreesBrutes && page.token && matchAvecClassement.urlClassement) {
            try {
                const session = { token: page.token, cookies: page.cookies };
                const cl = await fffApi(session, matchAvecClassement.urlClassement.replace('/api/', '/api/data/'));
                entreesBrutes = equipesDuClassement(cl);
            } catch (e) {
                logs.push('⚠️ Classement (API): ' + String(e.message).slice(0, 50));
            }
        }
    }
    if (entreesBrutes !== null) {
        try {
            const entrees = entreesBrutes.map(normaliserEntreeClassement);
            const valides = entrees.filter(function(e) { return e.position != null && e.points != null && e.team; });
            if (valides.length > 0 && valides.length === entrees.length) {
                updateData.standings_json = valides;
                const fcmb = valides.find(function(e) { return e.team.toUpperCase().includes('MONTCEAU'); });
                if (fcmb) {
                    updateData.standing_position = fcmb.position;
                    updateData.standing_points = fcmb.points;
                    if (fcmb.played != null) updateData.standing_played = fcmb.played;
                    if (fcmb.won != null) updateData.standing_won = fcmb.won;
                    if (fcmb.drawn != null) updateData.standing_drawn = fcmb.drawn;
                    if (fcmb.lost != null) updateData.standing_lost = fcmb.lost;
                    if (fcmb.goalsFor != null) updateData.standing_goals_for = fcmb.goalsFor;
                    if (fcmb.goalsAgainst != null) updateData.standing_goals_against = fcmb.goalsAgainst;
                }
                logs.push('✅ Classement: ' + valides.length + ' équipes' + (fcmb ? ', FCMB ' + fcmb.position + 'e' : ''));
            } else if (entrees.length > 0) {
                logs.push('⚠️ Classement: champs non reconnus, JSON brut ci-dessous pour ajuster normaliserEntreeClassement()');
                logs.push(JSON.stringify(entreesBrutes[0]).slice(0, 800));
            } else {
                logs.push('ℹ️ Classement pas encore disponible (normal en début de saison)');
            }
        } catch (e) {
            logs.push('⚠️ Classement: ' + e.message);
        }
    }

    return { updateData: updateData, logs: logs };
}

// ============================================
// SECOURS : SCRAPING SPORTCORICO (ancienne source)
// ============================================
async function scrapeSportCorico() {
    console.log('⚽ Scraping SportCorico...');
    const updateData = {};
    const logs = [];

    const html = await fetchHTML(SPORTCORICO_URL);
    const text = htmlToText(html);
    logs.push(`✅ SportCorico récupéré (${html.length} chars HTML → ${text.length} chars texte)`);

    const headerForm = parseForm(text);
    if (headerForm) {
        updateData.form = headerForm;
        logs.push(`✅ Forme: ${headerForm}`);
    }

    const { lastMatch, nextMatch } = parseHeaderMatches(text);

    if (lastMatch) {
        updateData.last_match_date = lastMatch.date;
        updateData.last_match_home_team = lastMatch.homeTeam;
        updateData.last_match_away_team = lastMatch.awayTeam;
        updateData.last_match_home_score = lastMatch.homeScore;
        updateData.last_match_away_score = lastMatch.awayScore;
        updateData.last_match_is_home = lastMatch.isHome;
        updateData.last_match_matchday = lastMatch.competition;
        logs.push(`✅ Dernier match: ${lastMatch.homeTeam} ${lastMatch.homeScore}-${lastMatch.awayScore} ${lastMatch.awayTeam} (${lastMatch.competition || 'compétition inconnue'})`);
    } else {
        logs.push('⚠️ Dernier match: la fiche club n\'affiche pas encore de score');
        try {
            const resultats = await parseResultatsDepuisPoule();
            if (resultats.length > 0) {
                const dernier = resultats[resultats.length - 1];
                updateData.last_match_date = dernier.date;
                updateData.last_match_home_team = dernier.homeTeam;
                updateData.last_match_away_team = dernier.awayTeam;
                updateData.last_match_home_score = dernier.homeScore;
                updateData.last_match_away_score = dernier.awayScore;
                updateData.last_match_is_home = dernier.isHome;
                updateData.last_match_matchday = 'Régional 1';
                logs.push(`✅ Dernier match (page poule): ${dernier.homeTeam} ${dernier.homeScore}-${dernier.awayScore} ${dernier.awayTeam}`);
            } else {
                logs.push('ℹ️ Page poule: aucun résultat de Montceau non plus');
            }
        } catch (e) {
            logs.push('⚠️ Page poule: ' + String(e.message).slice(0, 60));
        }
    }

    if (nextMatch) {
        updateData.next_match_date = nextMatch.date;
        updateData.next_match_time = nextMatch.time;
        updateData.next_match_home_team = nextMatch.homeTeam;
        updateData.next_match_away_team = nextMatch.awayTeam;
        updateData.next_match_is_home = nextMatch.isHome;
        updateData.next_match_matchday = nextMatch.competition;
        logs.push(`✅ Prochain match: ${nextMatch.homeTeam} vs ${nextMatch.awayTeam} le ${nextMatch.date} à ${nextMatch.time} (${nextMatch.competition || 'compétition inconnue'})`);
    } else {
        logs.push('⚠️ Prochain match absent de la fiche club');
        try {
            const secours = await parseProchainDepuisPoule();
            if (secours) {
                updateData.next_match_date = secours.date;
                updateData.next_match_time = secours.time;
                updateData.next_match_home_team = secours.homeTeam;
                updateData.next_match_away_team = secours.awayTeam;
                updateData.next_match_is_home = secours.isHome;
                updateData.next_match_matchday = 'Journée 1';
                logs.push(`✅ Prochain match (poule): ${secours.homeTeam} vs ${secours.awayTeam} le ${secours.date} à ${secours.time}`);
            } else {
                logs.push('⚠️ Aucun match à venir dans la poule non plus');
            }
        } catch (e) {
            logs.push('⚠️ Poule: erreur ' + e.message);
        }
    }

    const allResults = parseChampionnatResults(text);
    logs.push(`📊 ${allResults.length} matchs de championnat R1 trouvés`);

    const mois = new Date().getMonth(); // 6=juillet, 7=août, 8=septembre
    if (allResults.length === 0 && mois >= 6 && mois <= 8) {
        // Début de saison : on efface le classement de la saison précédente
        // (fenêtre limitée à juillet-septembre pour ne pas effacer de vraies
        // données en cours de saison si le parsing échouait un jour)
        updateData.standing_position = null;
        updateData.standings_json = null;
        updateData.standing_points = null;
        updateData.standing_played = null;
        updateData.standing_won = null;
        updateData.standing_drawn = null;
        updateData.standing_lost = null;
        updateData.standing_goals_for = null;
        updateData.standing_goals_against = null;
        logs.push('🧹 Intersaison : classement de la saison précédente effacé');
    }

    if (allResults.length > 0) {
        const stats = computeStats(allResults);
        updateData.standing_points = stats.points;
        updateData.standing_played = stats.played;
        updateData.standing_won = stats.won;
        updateData.standing_drawn = stats.drawn;
        updateData.standing_lost = stats.lost;
        updateData.standing_goals_for = stats.goalsFor;
        updateData.standing_goals_against = stats.goalsAgainst;
        logs.push(`✅ Stats: ${stats.points}pts, ${stats.played}J, ${stats.won}V-${stats.drawn}N-${stats.lost}D`);

        if (!headerForm) {
            updateData.form = computeFormFromResults(allResults);
            logs.push(`✅ Forme (calculée): ${updateData.form}`);
        }

        if (!lastMatch) {
            const sorted = [...allResults].sort((a, b) => a.date.localeCompare(b.date));
            const latest = sorted[sorted.length - 1];
            updateData.last_match_date = latest.date;
            updateData.last_match_home_team = latest.isHome ? 'FC Montceau' : latest.homeTeam.replace(/\s*\d+$/, '');
            updateData.last_match_away_team = latest.isHome ? latest.awayTeam.replace(/\s*\d+$/, '') : 'FC Montceau';
            updateData.last_match_home_score = latest.homeScore;
            updateData.last_match_away_score = latest.awayScore;
            updateData.last_match_is_home = latest.isHome;
            logs.push(`✅ Dernier match (résultats): ${latest.homeTeam} ${latest.homeScore}-${latest.awayScore} ${latest.awayTeam}`);
        }
    }

    return { updateData, logs };
}

// ============================================
// MISE À JOUR SUPABASE
// ============================================
async function updateSupabase(data) {
    const { data: existing } = await supabase
        .from('sport_data')
        .select('id')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

    const payload = { ...data, updated_at: new Date().toISOString(), updated_by: 'github-actions' };

    if (existing) {
        const { error } = await supabase.from('sport_data').update(payload).eq('id', existing.id);
        if (error) throw error;
        return 'updated';
    } else {
        const { error } = await supabase.from('sport_data').insert(payload);
        if (error) throw error;
        return 'inserted';
    }
}

// ============================================
// MAIN
// ============================================
async function main() {
    let result = null;

    // 1. Source principale : l'API publique de SportCorico (JSON propre,
    //    joignable depuis GitHub, donne matchs + classement + forme)
    try {
        result = await scrapeSportCoricoAPI();
    } catch (err) {
        console.warn('⚠️ API SportCorico indisponible (' + err.message + '), essai de la FFF...');
    }

    // 2. Secours : la FFF (fonctionne depuis un poste normal, bloquée depuis
    //    les serveurs — on tente quand même, au cas où le blocage tomberait)
    if (!result || Object.keys(result.updateData).length === 0) {
        try {
            console.log('⚽ Essai via la FFF (epreuves.fff.fr)...');
            result = await scrapeFFF();
        } catch (err) {
            console.warn('⚠️ FFF indisponible (' + err.message + '), lecture des pages SportCorico...');
            // Les logs de la tentative sont précieux : on les affiche
            (err.logs || []).forEach(l => console.warn('    ' + l));
        }
    }

    // 3. Dernier secours : lecture des pages HTML de SportCorico
    if (!result || Object.keys(result.updateData).length === 0) {
        try {
            result = await scrapeSportCorico();
        } catch (err) {
            console.error('❌ Toutes les sources ont échoué:', err);
            process.exit(1);
        }
    }

    const updateData = result.updateData;
    const logs = result.logs;

    // 3. Écriture Supabase
    try {
        if (Object.keys(updateData).length > 0) {
            try {
                const action = await updateSupabase(updateData);
                logs.push('✅ Supabase ' + action + ' (' + Object.keys(updateData).length + ' champs)');
            } catch (e) {
                // Si la colonne standings_json n'existe pas encore dans la table,
                // on réessaie sans elle plutôt que de tout perdre
                if ('standings_json' in updateData && /standings_json/i.test(e.message || '')) {
                    delete updateData.standings_json;
                    const action = await updateSupabase(updateData);
                    logs.push('⚠️ Colonne standings_json absente — mise à jour faite sans le classement complet (' + action + ')');
                } else {
                    throw e;
                }
            }
        } else {
            logs.push('⚠️ Aucune donnée à mettre à jour');
        }

        console.log('⚽ Scraping terminé:');
        logs.forEach(l => console.log('  ' + l));
    } catch (err) {
        console.error('❌ Erreur mise à jour Supabase:', err);
        process.exit(1);
    }
}

main();
