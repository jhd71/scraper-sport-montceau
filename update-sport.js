// update-sport.js - Script GitHub Actions pour FC Montceau Bourgogne
// Source: SportCorico + FFF
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Variables SUPABASE_URL et SUPABASE_ANON_KEY requises');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SPORTCORICO_URL = 'https://www.sportcorico.com/clubs/fc-montceau-bourgogne/montceau-fc-bourgogn';
const FFF_CLASSEMENT_URL = 'https://epreuves.fff.fr/competition/engagement/438243-regional-1-herbelin/phase/1/1/classement';
const POULE_URL = 'https://www.sportcorico.com/championnat/bourgogne-franche-comte-regional-1-herbelin-4/phase-unique/poule-a';
const COMPETITION = 'REGIONAL 1 HERBELIN';

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
// PARSER DERNIER MATCH + PROCHAIN MATCH
// ============================================
function parseHeaderMatches(text) {
    const result = { lastMatch: null, nextMatch: null };

    const dernierRegex = /Dernier Match\s+REGIONAL 1 HERBELIN\s+([\s\S]*?)(?:Prochain Match|Calendier)/i;
    const dernierMatch = dernierRegex.exec(text);

    if (dernierMatch) {
        const block = dernierMatch[1];
        const matchWithScore = block.match(/([\w\s'.()-]+\d)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s*-\s*(\d+)\s+([\w\s'.()-]+\d)/);

        if (matchWithScore) {
            const [, team1, dateStr, s1, s2, team2] = matchWithScore;
            const [day, month, year] = dateStr.split('/');
            const isHome = team1.trim().toLowerCase().includes('montceau');
            result.lastMatch = {
                date: `${year}-${month}-${day}`,
                homeTeam: isHome ? 'FC Montceau' : team1.replace(/\s*\d+$/, '').trim(),
                awayTeam: isHome ? team2.replace(/\s*\d+$/, '').trim() : 'FC Montceau',
                homeScore: parseInt(s1),
                awayScore: parseInt(s2),
                isHome: isHome,
            };
        }
    }

    const prochainRegex = /Prochain Match\s+REGIONAL 1 HERBELIN\s+([\s\S]*?)(?:Calendier|Classement)/i;
    const prochainMatch = prochainRegex.exec(text);

    if (prochainMatch) {
        const block = prochainMatch[1];
        const matchNext = block.match(/([\w\s'.()-]+\d)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+([\w\s'.()-]+\d)/);

        if (matchNext) {
            const [, team1, dateStr, time, team2] = matchNext;
            const [day, month, year] = dateStr.split('/');
            const isHome = team1.trim().toLowerCase().includes('montceau');
            result.nextMatch = {
                date: `${year}-${month}-${day}`,
                time: time,
                homeTeam: isHome ? 'FC Montceau' : team1.replace(/\s*\d+$/, '').trim(),
                awayTeam: isHome ? team2.replace(/\s*\d+$/, '').trim() : 'FC Montceau',
                isHome: isHome,
            };
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
            homeTeam: isHome ? 'FC Montceau' : t1.replace(/\s*\d+$/, '').trim(),
            awayTeam: isHome ? t2.replace(/\s*\d+$/, '').trim() : 'FC Montceau',
            isHome: isHome,
        };
    }

    return meilleur;
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
// PARSER CLASSEMENT FFF
// ============================================
async function fetchFFFStandings() {
    try {
        console.log('📊 Récupération classement FFF...');
        const html = await fetchHTML(FFF_CLASSEMENT_URL);
        console.log('📊 Page FFF récupérée:', html.length, 'chars');
        const standings = [];

        // METHODE 1: Parser les balises <td> du tableau HTML
        const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let trMatch;
        while ((trMatch = trRegex.exec(html)) !== null) {
            const row = trMatch[1];
            const cells = [];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            let tdMatch;
            while ((tdMatch = tdRegex.exec(row)) !== null) {
                cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
            }
            if (cells.length >= 13 && /^\d{1,2}$/.test(cells[0])) {
                const teamName = cells[2].replace(/^undefined\s*/i, '').trim();
                if (teamName && !isNaN(parseInt(cells[3]))) {
                    standings.push({
                        position: parseInt(cells[0]),
                        team: teamName,
                        points: parseInt(cells[3]) || 0,
                        played: parseInt(cells[4]) || 0,
                        won: parseInt(cells[5]) || 0,
                        drawn: parseInt(cells[6]) || 0,
                        lost: parseInt(cells[7]) || 0,
                        goalsFor: parseInt(cells[10]) || 0,
                        goalsAgainst: parseInt(cells[11]) || 0,
                        diff: parseInt(cells[12]) || 0,
                    });
                }
            }
        }

        if (standings.length >= 10) {
            console.log(`✅ Classement FFF HTML: ${standings.length} équipes`);
            return standings;
        }

        // METHODE 2: Parser le texte nettoyé
        const text = htmlToText(html);
        const lines = text.split('\n');
        let inTable = false;
        standings.length = 0;

        for (const line of lines) {
            if ((line.includes('Equipe') || line.includes('Équipe')) && line.includes('Pts') && (line.includes('Bp') || line.includes('G'))) {
                inTable = true;
                continue;
            }
            if (inTable) {
                const cleaned = line.replace(/undefined\s*/g, '').trim();
                const rowMatch = cleaned.match(/^(\d{1,2})\s+(?:\d*\s+)?([\w\s'.()éèêëàâäôùûüç,/-]+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+(\d+)\s+(\d+)\s+(-?\d+)/i);
                if (rowMatch) {
                    standings.push({
                        position: parseInt(rowMatch[1]),
                        team: rowMatch[2].trim(),
                        points: parseInt(rowMatch[3]),
                        played: parseInt(rowMatch[4]),
                        won: parseInt(rowMatch[5]),
                        drawn: parseInt(rowMatch[6]),
                        lost: parseInt(rowMatch[7]),
                        goalsFor: parseInt(rowMatch[8]),
                        goalsAgainst: parseInt(rowMatch[9]),
                        diff: parseInt(rowMatch[10]),
                    });
                }
                if (standings.length > 0 && (cleaned === '' || line.includes('Saison') || line.includes('Semaine'))) break;
            }
        }

        if (standings.length >= 10) {
            console.log(`✅ Classement FFF texte: ${standings.length} équipes`);
            return standings;
        }

        // METHODE 3: Regex markdown
        const mdRegex = /\|\s*(\d{1,2})\s*\|[^|]*\|[^|]*?((?:undefined\s+)?[A-ZÉÈÊËÀÂÄÔÙÛÜÇ][A-ZÉÈÊËÀÂÄÔÙÛÜÇ\s'.()0-9-]+?)\s*(?:\]\([^)]+\))?\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*\d+\s*\|\s*\d+\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(-?\d+)\s*\|/g;
        standings.length = 0;
        while ((m = mdRegex.exec(html)) !== null) {
            const teamName = m[2].replace(/^undefined\s*/i, '').trim();
            standings.push({
                position: parseInt(m[1]),
                team: teamName,
                points: parseInt(m[3]),
                played: parseInt(m[4]),
                won: parseInt(m[5]),
                drawn: parseInt(m[6]),
                lost: parseInt(m[7]),
                goalsFor: parseInt(m[8]),
                goalsAgainst: parseInt(m[9]),
                diff: parseInt(m[10]),
            });
        }

        if (standings.length > 0) {
            console.log(`✅ Classement FFF markdown: ${standings.length} équipes`);
            return standings;
        }

        console.warn('⚠️ Classement FFF: aucune donnée trouvée');
        return [];
    } catch (err) {
        console.warn('⚠️ Classement FFF non disponible:', err.message);
        return [];
    }
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
    try {
        console.log('⚽ Début scraping FC Montceau (SportCorico)...');
        const updateData = {};
        const logs = [];

        // 1. FETCH + NETTOYAGE
        const html = await fetchHTML(SPORTCORICO_URL);
        const text = htmlToText(html);
        logs.push(`✅ Page récupérée (${html.length} chars HTML → ${text.length} chars texte)`);

        // 2. FORME
        const headerForm = parseForm(text);
        if (headerForm) {
            updateData.form = headerForm;
            logs.push(`✅ Forme: ${headerForm}`);
        }

        // 3. DERNIER MATCH + PROCHAIN MATCH
        const { lastMatch, nextMatch } = parseHeaderMatches(text);

        if (lastMatch) {
            updateData.last_match_date = lastMatch.date;
            updateData.last_match_home_team = lastMatch.homeTeam;
            updateData.last_match_away_team = lastMatch.awayTeam;
            updateData.last_match_home_score = lastMatch.homeScore;
            updateData.last_match_away_score = lastMatch.awayScore;
            updateData.last_match_is_home = lastMatch.isHome;
            logs.push(`✅ Dernier match: ${lastMatch.homeTeam} ${lastMatch.homeScore}-${lastMatch.awayScore} ${lastMatch.awayTeam}`);
        } else {
            logs.push('⚠️ Dernier match: pas de score');
        }

        if (nextMatch) {
            updateData.next_match_date = nextMatch.date;
            updateData.next_match_time = nextMatch.time;
            updateData.next_match_home_team = nextMatch.homeTeam;
            updateData.next_match_away_team = nextMatch.awayTeam;
            updateData.next_match_is_home = nextMatch.isHome;
            logs.push(`✅ Prochain match: ${nextMatch.homeTeam} vs ${nextMatch.awayTeam} le ${nextMatch.date} à ${nextMatch.time}`);
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
                    logs.push(`✅ Prochain match (poule): ${secours.homeTeam} vs ${secours.awayTeam} le ${secours.date} à ${secours.time}`);
                } else {
                    logs.push('⚠️ Aucun match à venir dans la poule non plus');
                }
            } catch (e) {
                logs.push('⚠️ Poule: erreur ' + e.message);
            }
        }

        // 4. TOUS LES RÉSULTATS CHAMPIONNAT
        const allResults = parseChampionnatResults(text);
        logs.push(`📊 ${allResults.length} matchs de championnat R1 trouvés`);

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

        // 5. CLASSEMENT FFF
        try {
            const standings = await fetchFFFStandings();
            if (standings.length > 0) {
                updateData.standings_json = standings;
                const montceau = standings.find(s => s.team.toLowerCase().includes('montceau'));
                if (montceau) {
                    updateData.standing_position = montceau.position;
                    logs.push(`✅ Position FFF: ${montceau.position}e (${standings.length} équipes)`);
                }
                logs.push(`✅ Classement complet: ${standings.length} équipes`);
            }
        } catch (e) {
            logs.push('⚠️ Classement FFF: erreur ' + e.message);
        }

        // 6. SUPABASE
        if (Object.keys(updateData).length > 0) {
            const action = await updateSupabase(updateData);
            logs.push(`✅ Supabase ${action} (${Object.keys(updateData).length} champs)`);
        } else {
            logs.push('⚠️ Aucune donnée à mettre à jour');
        }

        console.log('⚽ Scraping terminé:');
        logs.forEach(l => console.log('  ' + l));

    } catch (err) {
        console.error('❌ Erreur scraping sport:', err);
        process.exit(1);
    }
}

main();
