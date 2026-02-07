const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();

// ============================================================================
// FONCTIONS UTILITAIRES POUR ESTIMATION RUPTURE AMÉLIORÉE
// ============================================================================

/**
 * Calcule la tendance de consommation pour les poulets (régression linéaire)
 * @param {Array} rations - Rations triées par date
 * @returns {number} - kg/jour d'augmentation
 */
function calculerTendancePoulet(rations) {
  if (rations.length < 3) return 0;
  
  // Préparer les données : x = jour (0, 1, 2...), y = quantité
  const n = rations.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  
  rations.forEach((r, i) => {
    const x = i;
    const y = parseFloat(r.quantiteTotale || 0);
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  });
  
  // Calcul de la pente (tendance)
  const tendance = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  return tendance || 0;
}

/**
 * Calcule l'estimation de rupture améliorée pour un silo/aliment
 * @param {Object} params - {batimentId, typeAliment, data, lots}
 * @returns {Object} - {stockActuel, estimationJours, warning}
 */
function calculerEstimationRuptureAmelioree(params) {
  const { batimentId, typeAliment, data, lots } = params;
  
  // 1. Calculer le stock actuel
  const silo = (data.batiments || []).find(b => b.id === batimentId);
  if (!silo || !silo.stocks) return { stockActuel: 0, estimationJours: 0, warning: null };
  
  const stockConfig = silo.stocks.find(s => s.type === typeAliment);
  if (!stockConfig) return { stockActuel: 0, estimationJours: 0, warning: null };
  
  const stockInitial = stockConfig.quantite || 0;
  const entrees = (data.entreesBat || [])
    .filter(e => e.batimentId === batimentId && e.typeStock === typeAliment)
    .reduce((sum, e) => sum + parseFloat(e.quantite || 0), 0);
  const sorties = (data.sortiesBat || [])
    .filter(s => s.batimentId === batimentId && s.typeStock === typeAliment)
    .reduce((sum, s) => sum + parseFloat(s.quantite || 0), 0);
  const rations = (data.rations || [])
    .filter(r => r.batimentId === batimentId && r.typeAliment === typeAliment)
    .reduce((sum, r) => sum + parseFloat(r.quantiteTotale || 0), 0);
  
  let stockActuel = stockInitial + entrees - sorties - rations;
  
  // 2. Récupérer les rations des 15 derniers jours
  const aujourdhui = new Date();
  aujourdhui.setHours(0, 0, 0, 0);
  const quinzeJoursAvant = new Date(aujourdhui);
  quinzeJoursAvant.setDate(quinzeJoursAvant.getDate() - 15);
  const dateQuinzeJours = quinzeJoursAvant.toISOString().split('T')[0];
  
  const rationsRecentes = (data.rations || [])
    .filter(r => r.batimentId === batimentId && r.typeAliment === typeAliment && r.date >= dateQuinzeJours)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  
  if (rationsRecentes.length === 0) {
    return { stockActuel, estimationJours: 999, warning: null };
  }
  
  // 3. Calculer le gap (jours manquants entre aujourd'hui et dernière ration)
  const derniereRation = rationsRecentes[rationsRecentes.length - 1];
  const dateDerniereRation = new Date(derniereRation.date);
  dateDerniereRation.setHours(0, 0, 0, 0);
  const gapJours = Math.floor((aujourdhui - dateDerniereRation) / (1000 * 60 * 60 * 24));
  
  // 4. Warning si gap > 3 jours
  let warning = null;
  if (gapJours > 3) {
    warning = 'Données trop anciennes (' + gapJours + 'j)';
  }
  
  // 5. Séparer les rations en 2 périodes : 7 derniers jours et 8-15 jours
  const septJoursAvant = new Date(aujourdhui);
  septJoursAvant.setDate(septJoursAvant.getDate() - 7);
  const dateSeptJours = septJoursAvant.toISOString().split('T')[0];
  
  const rationsPeriode1 = rationsRecentes.filter(r => r.date >= dateSeptJours); // 7 derniers jours
  const rationsPeriode2 = rationsRecentes.filter(r => r.date < dateSeptJours);  // 8-15 jours
  
  // 6. Calculer les moyennes par période
  const joursDistincts1 = [...new Set(rationsPeriode1.map(r => r.date))].length;
  const joursDistincts2 = [...new Set(rationsPeriode2.map(r => r.date))].length;
  
  const totalPeriode1 = rationsPeriode1.reduce((sum, r) => sum + parseFloat(r.quantiteTotale || 0), 0);
  const totalPeriode2 = rationsPeriode2.reduce((sum, r) => sum + parseFloat(r.quantiteTotale || 0), 0);
  
  const moyPeriode1 = joursDistincts1 > 0 ? totalPeriode1 / joursDistincts1 : 0;
  const moyPeriode2 = joursDistincts2 > 0 ? totalPeriode2 / joursDistincts2 : 0;
  
  // 7. Moyenne pondérée (ratio 2:1)
  let moyenneQuotidienne = 0;
  if (moyPeriode1 > 0 && moyPeriode2 > 0) {
    moyenneQuotidienne = (moyPeriode1 * 2 + moyPeriode2 * 1) / 3;
  } else if (moyPeriode1 > 0) {
    moyenneQuotidienne = moyPeriode1;
  } else if (moyPeriode2 > 0) {
    moyenneQuotidienne = moyPeriode2;
  }
  
  // 8. Gestion spéciale pour les poulets
  if (gapJours > 0) {
    // Trouver si c'est un lot de poulets
    const lotsPoulet = (lots || []).filter(l => l.type === 'Poulet');
    const rationsPoulet = rationsPeriode1.filter(r => 
      lotsPoulet.some(lot => lot.id === r.lotId)
    );
    
    if (rationsPoulet.length >= 3) {
      // Calculer la tendance (augmentation quotidienne)
      const tendance = calculerTendancePoulet(rationsPoulet);
      
      if (tendance > 0) {
        // Extrapoler la consommation pour les jours manquants
        let consoExtrapolee = 0;
        for (let i = 1; i <= gapJours; i++) {
          const consoJour = moyenneQuotidienne + (tendance * (rationsPoulet.length + i - 1));
          consoExtrapolee += consoJour;
        }
        
        // Corriger le stock actuel
        stockActuel -= consoExtrapolee;
        
        // Ajuster la moyenne avec la tendance
        moyenneQuotidienne = moyenneQuotidienne + (tendance * rationsPoulet.length);
      }
    }
  }
  
  // 9. Calculer l'estimation en jours
  const estimationJours = moyenneQuotidienne > 0 ? Math.floor(stockActuel / moyenneQuotidienne) : 999;
  
  return { stockActuel, estimationJours, warning, moyenneQuotidienne };
}

// ===== FONCTION PRINCIPALE - TOUS LES JOURS À 8H =====
exports.envoyerNotificationsQuotidiennes = onSchedule({
  schedule: '0 8 * * *',
  timeZone: 'Europe/Paris',
  memory: '256MiB'
}, async (event) => {
  const db = admin.firestore();
  const aujourdhui = new Date().toISOString().split('T')[0];
  const hier = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  
  console.log('🔔 Début envoi notifications pour le', aujourdhui);
  
  try {
    const dataDoc = await db.collection('tchapot').doc('data').get();
    if (!dataDoc.exists) {
      console.log('❌ Pas de données');
      return null;
    }
    
    const data = dataDoc.data();
    const usersSnapshot = await db.collection('users').get();
    
    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const fcmToken = userData.fcmToken;
      
      if (!fcmToken) {
        console.log(`⭐️ Pas de token pour ${userDoc.id}`);
        continue;
      }
      
      const notifications = [];
      
      // ===== 1. ÉVÉNEMENTS PONCTUELS DU JOUR =====
     const eventsAujourdhui = (data.evenements || []).filter(e => 
  e.date === aujourdhui && !e.valide
);

eventsAujourdhui.forEach(evt => {
  let titre = 'Aujourd\'hui';
  if (evt.heure) {
    titre += ' à ' + evt.heure;
  }
  titre += ' ' + evt.titre;
  
  notifications.push({
    title: '📅 ' + titre,
    body: evt.description || '' // Vide si pas de description
  });
});
      
      // ===== 2. ÉVÉNEMENTS AUTOMATIQUES DES LOTS =====
      (data.lots || []).forEach(lot => {
        if (!lot.evenementsAuto || !Array.isArray(lot.evenementsAuto)) return;
        
        lot.evenementsAuto.forEach(evt => {
          const evtDate = new Date(evt.date);
          evtDate.setHours(0, 0, 0, 0);
          const currentDate = new Date(aujourdhui);
          currentDate.setHours(0, 0, 0, 0);
          
          // Événement ponctuel aujourd'hui
          if (evtDate.getTime() === currentDate.getTime() && !evt.dateFin) {
            let titre = 'Aujourd\'hui ';
            let nomEvt = '';
            
            // Personnaliser selon le type
            if (evt.type === 'poseEponge') nomEvt = 'Pose éponge';
            else if (evt.type === 'retraitEponge') nomEvt = 'Retrait éponge';
            else if (evt.type === 'poseSpiraleVache') nomEvt = 'Pose spirale';
            else if (evt.type === 'piqurePGF') nomEvt = 'Piqûre PGF';
            else if (evt.type === 'retraitSpiraleVache') nomEvt = 'Retrait spirale';
            else if (evt.type === 'ouvertureAliments') nomEvt = 'Ouverture aliment';
            else if (evt.type === 'stopLait') nomEvt = 'Stop lait';
            else if (evt.type === 'sevrage') nomEvt = 'Sevrage';
            else if (evt.type === 'echoRdv') nomEvt = 'RDV Échographie';
            else if (evt.type === 'peseeRdv') nomEvt = 'RDV Pesée';
            else if (evt.type === 'commandeGaz') nomEvt = 'Commander gaz';
            else if (evt.type === 'commandeAliment') nomEvt = 'Commander aliment';
            else if (evt.type === 'vaccin1') nomEvt = 'Vaccin 1';
            else if (evt.type === 'vaccin2') nomEvt = 'Vaccin 2';
            else if (evt.type === 'peseePoulet1') nomEvt = 'Pesée 1';
            else if (evt.type === 'peseePoulet2') nomEvt = 'Pesée 2';
            else if (evt.type === 'peseePoulet3') nomEvt = 'Pesée 3';
            else if (evt.type === 'biaminticRdv') nomEvt = 'RDV Biamintic';
            else if (evt.type === 'gallifenRdv') nomEvt = 'RDV Gallifen';
            else nomEvt = evt.titre || 'Événement';
            
            titre += nomEvt + ' - ' + lot.nom;
            
            notifications.push({
              title: '🐑 ' + titre,
              body: lot.type + ' • ' + lot.nombreTetes + ' têtes'
            });
          }
          
          // ===== 3. DÉBUT ET FIN DE PÉRIODES =====
          if (evt.dateFin) {
            const evtDebut = new Date(evt.date);
            const evtFin = new Date(evt.dateFin);
            evtDebut.setHours(0, 0, 0, 0);
            evtFin.setHours(0, 0, 0, 0);
            
            let nomPeriode = '';
            if (evt.type === 'birthStart') nomPeriode = 'mise bas';
            else if (evt.type === 'flushing') nomPeriode = 'flushing';
            else if (evt.type === 'lutteStart') nomPeriode = 'lutte';
            else if (evt.type === 'lutteRetourStart') nomPeriode = 'lutte retours';
            
            if (nomPeriode) {
              // Début de période
              if (evtDebut.getTime() === currentDate.getTime()) {
                notifications.push({
                  title: '🐑 Aujourd\'hui début ' + nomPeriode,
                  body: lot.nom + ' - Du ' + formatDate(evt.date) + ' au ' + formatDate(evt.dateFin)
                });
              }
              
              // Fin de période
              if (evtFin.getTime() === currentDate.getTime()) {
                notifications.push({
                  title: '🐑 Aujourd\'hui fin ' + nomPeriode,
                  body: lot.nom + ' - Période du ' + formatDate(evt.date) + ' au ' + formatDate(evt.dateFin)
                });
              }
            }
          }
        });
      });
      
      // ===== 4. VÉRIFICATION STOCKS SILOS (VERSION AMÉLIORÉE) =====
      const silos = (data.batiments || []).filter(b => b.type === 'Silos');
      
      for (const silo of silos) {
        if (!silo.stocks || silo.stocks.length === 0) continue;
        
        for (const stock of silo.stocks) {
          const typeAliment = stock.type;
          
          // Utiliser la nouvelle fonction améliorée
          const estimation = calculerEstimationRuptureAmelioree({
            batimentId: silo.id,
            typeAliment: typeAliment,
            data: data,
            lots: data.lots || []
          });
          
          // Alerte si stock < 5 jours de consommation
          if (estimation.estimationJours <= 5 && estimation.moyenneQuotidienne > 0) {
            let body = 'Rupture estimée dans ' + estimation.estimationJours + ' jour' + (estimation.estimationJours > 1 ? 's' : '') + ' (stock: ' + estimation.stockActuel.toFixed(0) + ' kg)';
            
            // Ajouter le warning si présent
            if (estimation.warning) {
              body += ' ⚠️ ' + estimation.warning;
            }
            
            notifications.push({
              title: '⚠️ ' + silo.nom + ' - ' + typeAliment,
              body: body
            });
          }
        }
      }
      
      // ===== 5. VÉRIFICATION RATIONS DE LA VEILLE =====
      const rationsHier = (data.rations || []).filter(r => r.date === hier);
      
      if (rationsHier.length === 0) {
        notifications.push({
          title: '⚠️ Aucune ration enregistrée',
          body: 'Aucune ration n\'a été enregistrée hier (' + formatDate(hier) + ')'
        });
      }
      
      // ===== ENVOI DES NOTIFICATIONS =====
      for (const notif of notifications) {
        try {
          const message = {
            notification: {
              title: notif.title,
              body: notif.body
            },
            token: fcmToken,
            webpush: {
              fcmOptions: {
                link: 'https://tchapot-de-ghislain.web.app'
              }
            }
          };
          
          await admin.messaging().send(message);
          console.log(`✅ Notification envoyée à ${userDoc.id}: ${notif.title}`);
        } catch (error) {
          console.error(`❌ Erreur envoi à ${userDoc.id}:`, error);
          
          if (error.code === 'messaging/invalid-registration-token' ||
              error.code === 'messaging/registration-token-not-registered') {
            await db.collection('users').doc(userDoc.id).update({
              fcmToken: admin.firestore.FieldValue.delete()
            });
            console.log(`🗑️ Token invalide supprimé`);
          }
        }
      }
    }
    
    console.log('✅ Traitement terminé');
    return null;
    
  } catch (error) {
    console.error('❌ Erreur globale:', error);
    return null;
  }
});

// ===== FONCTION HEBDOMADAIRE - DIMANCHE 21H =====
exports.envoyerRecapHebdomadaire = onSchedule({
  schedule: '0 21 * * 0', // Dimanche à 21h
  timeZone: 'Europe/Paris',
  memory: '256MiB'
}, async (event) => {
  const db = admin.firestore();
  
  // Calculer les dates de la semaine à venir (lundi à dimanche)
  const aujourdhui = new Date();
  const lundi = new Date(aujourdhui);
  lundi.setDate(aujourdhui.getDate() + 1); // Demain = lundi
  lundi.setHours(0, 0, 0, 0);
  
  const dimanche = new Date(lundi);
  dimanche.setDate(lundi.getDate() + 6);
  dimanche.setHours(23, 59, 59, 999);
  
  const lundiStr = lundi.toISOString().split('T')[0];
  const dimancheStr = dimanche.toISOString().split('T')[0];
  
  console.log('📅 Récap hebdomadaire du', lundiStr, 'au', dimancheStr);
  
  try {
    const dataDoc = await db.collection('tchapot').doc('data').get();
    if (!dataDoc.exists) {
      console.log('❌ Pas de données');
      return null;
    }
    
    const data = dataDoc.data();
    const usersSnapshot = await db.collection('users').get();
    
    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const fcmToken = userData.fcmToken;
      
      if (!fcmToken) continue;
      
      // ===== COLLECTER TOUS LES ÉVÉNEMENTS DE LA SEMAINE =====
      const evenementsSemaine = [];
      
      // 1. Événements manuels
      (data.evenements || []).forEach(evt => {
        const evtDate = new Date(evt.date);
        if (evtDate >= lundi && evtDate <= dimanche && !evt.valide) {
          let titre = formatDateComplet(evt.date);
          if (evt.heure) titre += ' à ' + evt.heure;
          titre += ' - ' + evt.titre;
          
          evenementsSemaine.push({
            date: evt.date,
            titre: titre,
            description: evt.description || '',
            type: 'manuel'
          });
        }
      });
      
      // 2. Événements automatiques des lots
      (data.lots || []).forEach(lot => {
        if (!lot.evenementsAuto) return;
        
        lot.evenementsAuto.forEach(evt => {
          const evtDate = new Date(evt.date);
          evtDate.setHours(0, 0, 0, 0);
          
          // Événements ponctuels dans la semaine
          if (evtDate >= lundi && evtDate <= dimanche && !evt.dateFin) {
            let nomEvt = getNomEvenementAuto(evt.type);
            let titre = formatDateComplet(evt.date) + ' - ' + nomEvt + ' (' + lot.nom + ')';
            
            evenementsSemaine.push({
              date: evt.date,
              titre: titre,
              description: lot.type + ' • ' + lot.nombreTetes + ' têtes',
              type: 'auto'
            });
          }
          
          // Périodes qui commencent ou finissent dans la semaine
          if (evt.dateFin) {
            const evtDebut = new Date(evt.date);
            const evtFin = new Date(evt.dateFin);
            evtDebut.setHours(0, 0, 0, 0);
            evtFin.setHours(23, 59, 59, 999);
            
            const nomPeriode = getNomPeriode(evt.type);
            
            if (nomPeriode) {
              // Début de période dans la semaine
              if (evtDebut >= lundi && evtDebut <= dimanche) {
                evenementsSemaine.push({
                  date: evt.date,
                  titre: formatDateComplet(evt.date) + ' - Début ' + nomPeriode + ' (' + lot.nom + ')',
                  description: 'Jusqu\'au ' + formatDateComplet(evt.dateFin),
                  type: 'auto'
                });
              }
              
              // Fin de période dans la semaine
              if (evtFin >= lundi && evtFin <= dimanche) {
                evenementsSemaine.push({
                  date: evt.dateFin,
                  titre: formatDateComplet(evt.dateFin) + ' - Fin ' + nomPeriode + ' (' + lot.nom + ')',
                  description: 'Période commencée le ' + formatDateComplet(evt.date),
                  type: 'auto'
                });
              }
            }
          }
        });
      });
      
      // Trier par date
      evenementsSemaine.sort((a, b) => new Date(a.date) - new Date(b.date));
      
      // ===== CALCULER STOCKS SILOS (VERSION AMÉLIORÉE) =====
      const stocksInfo = [];
      const silos = (data.batiments || []).filter(b => b.type === 'Silos');
      
      for (const silo of silos) {
        if (!silo.stocks || silo.stocks.length === 0) continue;
        
        for (const stock of silo.stocks) {
          const typeAliment = stock.type;
          
          // Utiliser la nouvelle fonction améliorée
          const estimation = calculerEstimationRuptureAmelioree({
            batimentId: silo.id,
            typeAliment: typeAliment,
            data: data,
            lots: data.lots || []
          });
          
          stocksInfo.push({
            silo: silo.nom,
            aliment: typeAliment,
            stock: estimation.stockActuel,
            moyenne: estimation.moyenneQuotidienne || 0,
            jours: estimation.estimationJours,
            warning: estimation.warning
          });
        }
      }
      
      // ===== CONSTRUIRE ET ENVOYER LES NOTIFICATIONS =====
      
      // 1. Notification des événements - UNE PAR JOUR
      if (evenementsSemaine.length > 0) {
        // Grouper par jour
        const evtsParJour = {};
        evenementsSemaine.forEach(evt => {
          const jour = formatJourSemaine(evt.date);
          if (!evtsParJour[jour]) evtsParJour[jour] = [];
          evtsParJour[jour].push(evt);
        });
        
        // Envoyer UNE notification PAR JOUR
        for (const jour in evtsParJour) {
          const evts = evtsParJour[jour];
          let body = '';
          
          evts.forEach((evt, idx) => {
            if (idx > 0) body += '\n';
            body += '• ' + evt.titre.split(' - ').slice(1).join(' - '); // Enlever la date du titre
            if (evt.description) body += '\n  ' + evt.description;
          });
          
          try {
            await admin.messaging().send({
              notification: {
                title: '📅 ' + jour + ' (' + evts.length + ' événement' + (evts.length > 1 ? 's' : '') + ')',
                body: body
              },
              token: fcmToken,
              webpush: {
                fcmOptions: {
                  link: 'https://tchapot-de-ghislain.web.app'
                }
              }
            });
            console.log(`✅ Notif événement ${jour} envoyée`);
          } catch (error) {
            console.error('Erreur notification événement:', error);
          }
        }
      }
      
      // 2. Notification des stocks - UNE PAR SILO
      if (stocksInfo.length > 0) {
        // Grouper par silo
        const stocksParSilo = {};
        stocksInfo.forEach(s => {
          if (!stocksParSilo[s.silo]) stocksParSilo[s.silo] = [];
          stocksParSilo[s.silo].push(s);
        });
        
        // Envoyer UNE notification PAR SILO
        for (const siloNom in stocksParSilo) {
          const stocks = stocksParSilo[siloNom];
          let body = '';
          
		  let ligneIndex = 0;
          stocks.forEach((s) => {
			if (s.stock <= 0) return;
			
            if (ligneIndex > 0) body += '\n';
            body += s.aliment + ' ' + s.stock.toFixed(0) + 'kg';
            
            if (s.jours >= 999) {
              body += ', pas de conso récente';
            } else {
              body += ', rupture dans ' + s.jours + 'j';
            }
            
            // Ajouter le warning si présent
            if (s.warning) {
              body += ' ⚠️ ' + s.warning;
            }
			
			ligneIndex++;
          });
          
		  if (body === '') continue;
		  
          try {
            await admin.messaging().send({
              notification: {
                title: '📦 ' + siloNom,
                body: body
              },
              token: fcmToken,
              webpush: {
                fcmOptions: {
                  link: 'https://tchapot-de-ghislain.web.app'
                }
              }
            });
            console.log(`✅ Notif stock ${siloNom} envoyée`);
          } catch (error) {
            console.error('Erreur notification stock:', error);
          }
        }
      }
      
      console.log(`✅ Récap hebdo envoyé à ${userDoc.id}`);
    }
    
    return null;
  } catch (error) {
    console.error('❌ Erreur récap hebdo:', error);
    return null;
  }
});

// ===== FONCTIONS UTILITAIRES SUPPLÉMENTAIRES =====
function getNomEvenementAuto(type) {
  if (type === 'poseEponge') return 'Pose éponge';
  if (type === 'retraitEponge') return 'Retrait éponge';
  if (type === 'poseSpiraleVache') return 'Pose spirale';
  if (type === 'piqurePGF') return 'Piqûre PGF';
  if (type === 'retraitSpiraleVache') return 'Retrait spirale';
  if (type === 'ouvertureAliments') return 'Ouverture aliment';
  if (type === 'stopLait') return 'Stop lait';
  if (type === 'sevrage') return 'Sevrage';
  if (type === 'echoRdv') return 'RDV Échographie';
  if (type === 'peseeRdv') return 'RDV Pesée';
  if (type === 'commandeGaz') return 'Commander gaz';
  if (type === 'commandeAliment') return 'Commander aliment';
  if (type === 'vaccin1') return 'Vaccin 1';
  if (type === 'vaccin2') return 'Vaccin 2';
  if (type === 'peseePoulet1') return 'Pesée 1';
  if (type === 'peseePoulet2') return 'Pesée 2';
  if (type === 'peseePoulet3') return 'Pesée 3';
  if (type === 'biaminticRdv') return 'RDV Biamintic';
  if (type === 'gallifenRdv') return 'RDV Gallifen';
  return 'Événement';
}

function getNomPeriode(type) {
  if (type === 'birthStart') return 'mise bas';
  if (type === 'flushing') return 'flushing';
  if (type === 'lutteStart') return 'lutte';
  if (type === 'lutteRetourStart') return 'lutte retours';
  return '';
}

function formatDateComplet(dateStr) {
  const date = new Date(dateStr);
  const jours = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const jour = String(date.getDate()).padStart(2, '0');
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  return jours[date.getDay()] + ' ' + jour + '/' + mois;
}

function formatJourSemaine(dateStr) {
  const date = new Date(dateStr);
  const jours = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const jour = String(date.getDate()).padStart(2, '0');
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  return jours[date.getDay()] + ' ' + jour + '/' + mois;
}

// ===== FONCTION UTILITAIRE =====
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const jour = String(date.getDate()).padStart(2, '0');
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  return jour + '/' + mois;
}