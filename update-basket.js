// update-basket.js - Script GitHub Actions pour le Basket Montceau Bourgogne
// Source : Score'n'co (partenaire officiel FFBB)
//
// Ce script écrit DEUX lignes dans la table sport_data :
//   team_key = 'basket_m'  -> BMB Senior M1 (Pré Nationale Masculine)
//   team_key = 'basket_f'  -> BMB Senior F1 (Pré Nationale Féminine)
// La ligne du foot (team_key = 'foot') est écrite par update-sport.js et
// n'est jamais touchée ici.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
// Comme update-sport.js : clé service_role, qui ignore les règles RLS.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Mode essai : sans identifiants Supabase, le script affiche ce qu'il aurait
// écrit au lieu d'écrire. Pratique pour tester sur son PC.
const MODE_ESSAI = !SUPABASE_URL || !SUPABASE_KEY;

const supabase = MODE_ESSAI ? null : createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================
// CONFIG
// ============================================
const API = 'https://graphql.scorenco.com/v1/graphql';
const SITE = 'https://scorenco.com';

// Identifiants Score'n'co, stables d'une saison à l'autre (ce sont les
// équipes du club, pas les compétitions).
const EQUIPES = [
    {
        key: 'basket_m',
        teamId: 70969,
        label: 'BMB Masculins',
        nomCourt: 'BMB',
        ordre: 2,
        url: SITE + '/basket/clubs/basket-montceau-bourgogne-2m56/1-1ird'
    },
    {
        key: 'basket_f',
        teamId: 124456,
        label: 'BMB Féminines',
        nomCourt: 'BMB',
        ordre: 3,
        url: SITE + '/basket/clubs/basket-montceau-bourgogne-2m56/1-feminine-2o14'
    }
];

const CLUB_ID = 122010; // Basket Montceau Bourgogne

// ============================================
// APPEL DE L'API
// ============================================
async function graphql(query) {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), 15000);

    try {
        const r = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
            signal: controleur.signal
        });

        if (!r.ok) throw new Error('HTTP ' + r.status);

        const json = await r.json();
        if (json.errors) throw new Error(JSON.stringify(json.errors));
        return json.data;
    } finally {
        clearTimeout(minuteur);
    }
}

const CHAMPS_MATCH = `
    id date time status level_name url
    round { rank name }
    playing_teams {
        role
        score
        team_in_season { team { id club { id name short_name } } }
    }
`;

async function lireEquipes() {
    const ids = EQUIPES.map(e => e.teamId).join(',');
    const data = await graphql(`{
        teams_team(where: { id: { _in: [${ids}] } }) {
            id
            current_team_detail {
                level_name
                name_in_club
                competitions { competition { id name pool } }
            }
            last_events { ${CHAMPS_MATCH} }
            next_events { ${CHAMPS_MATCH} }
        }
    }`);
    return data.teams_team || [];
}

async function lireClassement(competitionId) {
    const data = await graphql(`{
        competitions_competition(where: { id: { _eq: ${competitionId} } }) {
            rankings {
                rank pts played win lost even gf ga gd
                team { id name club { id name short_name } }
            }
        }
    }`);
    const comp = (data.competitions_competition || [])[0];
    return (comp && comp.rankings) || [];
}

// ============================================
// OUTILS
// ============================================

// "2026-09-12T18:00:00+00:00" -> "20:00" (heure de Paris)
function heureParis(iso) {
    if (!iso) return null;
    try {
        return new Date(iso).toLocaleTimeString('fr-FR', {
            timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit'
        });
    } catch (e) {
        return null;
    }
}

// "2026-09-12T18:00:00+00:00" -> "2026-09-12" (jour à Paris)
function dateParis(iso, secours) {
    if (!iso) return secours || null;
    try {
        return new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
    } catch (e) {
        return secours || null;
    }
}

// "1ère journée" -> "Journée 1"
function libelleJournee(round) {
    if (!round) return null;
    if (round.rank) return 'Journée ' + round.rank;
    return round.name || null;
}

// Nom d'équipe pour l'affichage : le BMB garde son sigle, les autres
// gardent le nom de leur club.
function nomEquipe(pt, nomCourtBMB) {
    const club = pt && pt.team_in_season && pt.team_in_season.team && pt.team_in_season.team.club;
    if (!club) return '?';
    if (club.id === CLUB_ID) return nomCourtBMB;
    return club.name || club.short_name || '?';
}

function estBMB(pt) {
    const club = pt && pt.team_in_season && pt.team_in_season.team && pt.team_in_season.team.club;
    return !!club && club.id === CLUB_ID;
}

function aujourdhuiParis() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
}

// Un match compte comme joué s'il est terminé ET qu'il a deux scores.
function estJoue(ev) {
    if (!ev || ev.status !== 'finish') return false;
    const scores = (ev.playing_teams || []).map(p => p.score);
    return scores.length === 2 && scores.every(s => s !== null && s !== undefined);
}

// ============================================
// CONSTRUCTION DES DONNÉES D'UNE ÉQUIPE
// ============================================
function construire(equipe, brut, classement) {
    const logs = [];
    const detail = (brut.current_team_detail || [])[0] || {};
    const competition = detail.level_name || null;

    const donnees = {
        team_key: equipe.key,
        team_label: equipe.label,
        competition_label: competition,
        sport: 'basket',
        source_name: "Score'n'co",
        source_url: equipe.url,
        display_order: equipe.ordre,

        last_match_date: null,
        last_match_time: null,
        last_match_matchday: null,
        last_match_home_team: null,
        last_match_away_team: null,
        last_match_home_score: null,
        last_match_away_score: null,
        last_match_is_home: null,

        next_match_date: null,
        next_match_time: null,
        next_match_matchday: null,
        next_match_home_team: null,
        next_match_away_team: null,
        next_match_is_home: null,

        standing_position: null,
        standing_points: null,
        standing_played: null,
        standing_won: null,
        standing_drawn: null,
        standing_lost: null,
        standing_goals_for: null,
        standing_goals_against: null,
        form: null,
        standings_json: null
    };

    // --- DERNIER MATCH ---
    // last_events est trié du plus récent au plus ancien, mais il contient
    // parfois des matchs jamais joués (reportés) : on prend le premier
    // vraiment terminé.
    const joues = (brut.last_events || []).filter(estJoue);
    const dernier = joues[0];

    if (dernier) {
        const dom = dernier.playing_teams.find(p => p.role === 'home');
        const ext = dernier.playing_teams.find(p => p.role === 'away');

        donnees.last_match_date = dateParis(dernier.time, dernier.date);
        donnees.last_match_time = heureParis(dernier.time);
        donnees.last_match_matchday = libelleJournee(dernier.round);
        donnees.last_match_home_team = nomEquipe(dom, equipe.nomCourt);
        donnees.last_match_away_team = nomEquipe(ext, equipe.nomCourt);
        donnees.last_match_home_score = dom ? dom.score : null;
        donnees.last_match_away_score = ext ? ext.score : null;
        donnees.last_match_is_home = estBMB(dom);

        logs.push(`✅ Dernier match : ${donnees.last_match_home_team} ${donnees.last_match_home_score}-${donnees.last_match_away_score} ${donnees.last_match_away_team} (${donnees.last_match_date})`);
    } else {
        logs.push('⚠️ Aucun match joué trouvé');
    }

    // --- PROCHAIN MATCH ---
    const jour = aujourdhuiParis();
    const aVenir = (brut.next_events || [])
        .filter(ev => (dateParis(ev.time, ev.date) || '') >= jour && ev.status !== 'finish')
        .sort((a, b) => (a.time || a.date).localeCompare(b.time || b.date));
    const prochain = aVenir[0];

    if (prochain) {
        const dom = prochain.playing_teams.find(p => p.role === 'home');
        const ext = prochain.playing_teams.find(p => p.role === 'away');

        donnees.next_match_date = dateParis(prochain.time, prochain.date);
        donnees.next_match_time = heureParis(prochain.time);
        donnees.next_match_matchday = libelleJournee(prochain.round);
        donnees.next_match_home_team = nomEquipe(dom, equipe.nomCourt);
        donnees.next_match_away_team = nomEquipe(ext, equipe.nomCourt);
        donnees.next_match_is_home = estBMB(dom);

        logs.push(`✅ Prochain match : ${donnees.next_match_home_team} vs ${donnees.next_match_away_team} le ${donnees.next_match_date} à ${donnees.next_match_time}`);
    } else {
        logs.push('⚠️ Aucun match à venir au calendrier');
    }

    // --- FORME (5 derniers matchs, du plus ancien au plus récent) ---
    if (joues.length > 0) {
        const lettres = joues.slice(0, 5).reverse().map(ev => {
            const nous = ev.playing_teams.find(estBMB);
            const eux = ev.playing_teams.find(p => !estBMB(p));
            if (!nous || !eux) return 'D';
            if (nous.score > eux.score) return 'V';
            if (nous.score < eux.score) return 'D';
            return 'N'; // n'arrive pas au basket, mais on ne présume rien
        });
        donnees.form = lettres.join(',');
        logs.push('✅ Forme : ' + donnees.form);
    }

    // --- CLASSEMENT ---
    if (classement && classement.length > 0) {
        const trie = [...classement].sort((a, b) => (a.rank || 99) - (b.rank || 99));

        donnees.standings_json = trie.map(l => ({
            position: l.rank,
            team: (l.team && l.team.club && l.team.club.id === CLUB_ID)
                ? 'Basket Montceau Bourgogne'
                : ((l.team && (l.team.name || (l.team.club && l.team.club.name))) || '?'),
            points: l.pts,
            played: l.played,
            won: l.win,
            drawn: l.even || 0,
            lost: l.lost,
            goalsFor: l.gf,
            goalsAgainst: l.ga,
            diff: (l.gd !== null && l.gd !== undefined) ? l.gd : (l.gf - l.ga)
        }));

        const nous = trie.find(l => l.team && l.team.club && l.team.club.id === CLUB_ID);
        if (nous) {
            donnees.standing_position = nous.rank;
            donnees.standing_points = nous.pts;
            donnees.standing_played = nous.played;
            donnees.standing_won = nous.win;
            donnees.standing_drawn = nous.even || 0;
            donnees.standing_lost = nous.lost;
            donnees.standing_goals_for = nous.gf;
            donnees.standing_goals_against = nous.ga;
            logs.push(`🏆 Classement : ${trie.length} équipes, BMB ${nous.rank}e avec ${nous.pts} pts`);
        } else {
            logs.push(`🏆 Classement récupéré (${trie.length} équipes) mais le BMB n'y figure pas`);
        }
    } else {
        logs.push('ℹ️ Pas encore de classement (saison non commencée)');
    }

    return { donnees, logs };
}

// ============================================
// ÉCRITURE SUPABASE
// ============================================
async function ecrire(donnees) {
    const payload = {
        ...donnees,
        updated_at: new Date().toISOString(),
        updated_by: 'github-actions-basket'
    };

    const { data: existant } = await supabase
        .from('sport_data')
        .select('id')
        .eq('team_key', donnees.team_key)
        .limit(1)
        .maybeSingle();

    if (existant) {
        const { error } = await supabase.from('sport_data').update(payload).eq('id', existant.id);
        if (error) throw error;
        return 'mise à jour';
    }

    const { error } = await supabase.from('sport_data').insert(payload);
    if (error) throw error;
    return 'créée';
}

// ============================================
// MAIN
// ============================================
async function main() {
    if (MODE_ESSAI) {
        console.log('🧪 MODE ESSAI : pas de SUPABASE_URL / SUPABASE_SERVICE_KEY,');
        console.log('   le script affiche les données au lieu de les enregistrer.\n');
    }

    let equipesBrutes;
    try {
        equipesBrutes = await lireEquipes();
    } catch (err) {
        console.error("❌ API Score'n'co injoignable :", err.message);
        process.exit(1);
    }

    let echecs = 0;

    for (const equipe of EQUIPES) {
        console.log(`\n🏀 ${equipe.label}`);

        const brut = equipesBrutes.find(t => t.id === equipe.teamId);
        if (!brut) {
            console.error(`  ❌ Équipe ${equipe.teamId} introuvable sur Score'n'co`);
            echecs++;
            continue;
        }

        // Classement de la compétition en cours (vide en début de saison)
        let classement = [];
        const detail = (brut.current_team_detail || [])[0] || {};
        const comp = ((detail.competitions || [])[0] || {}).competition;
        if (comp && comp.id) {
            try {
                classement = await lireClassement(comp.id);
            } catch (e) {
                console.warn('  ⚠️ Classement indisponible : ' + e.message);
            }
        }

        const { donnees, logs } = construire(equipe, brut, classement);
        logs.forEach(l => console.log('  ' + l));

        if (MODE_ESSAI) {
            console.log('  📋 ' + JSON.stringify({
                ...donnees,
                standings_json: donnees.standings_json
                    ? donnees.standings_json.length + ' équipes'
                    : null
            }, null, 2).replace(/\n/g, '\n  '));
            continue;
        }

        try {
            const action = await ecrire(donnees);
            console.log(`  ✅ Supabase : ligne ${equipe.key} ${action}`);
        } catch (err) {
            console.error(`  ❌ Écriture Supabase impossible : ${err.message}`);
            echecs++;
        }
    }

    if (echecs > 0) process.exit(1);
    console.log('\n🏀 Terminé.');
}

main();
