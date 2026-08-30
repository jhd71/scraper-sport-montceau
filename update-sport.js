// update-sport.js - Script GitHub Actions pour FC Montceau Bourgogne
// Source: SportCorico
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Variables SUPABASE_URL et SUPABASE_ANON_KEY requises');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SPORTCORICO_URL = 'https://www.sportcorico.com/clubs/fc-montceau-bourgogne/montceau-fc-bourgogn';
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
            updateData.last_match_matchday = lastMatch.competition;
            logs.push(`✅ Dernier match: ${lastMatch.homeTeam} ${lastMatch.homeScore}-${lastMatch.awayScore} ${lastMatch.awayTeam} (${lastMatch.competition || 'compétition inconnue'})`);
        } else {
            logs.push('⚠️ Dernier match: pas de score');
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

        // 5. SUPABASE
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
