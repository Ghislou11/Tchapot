const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();

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
      
      // ===== 4. VÉRIFICATION STOCKS SILOS =====
      const silos = (data.batiments || []).filter(b => b.type === 'Silos');
      
      for (const silo of silos) {
        if (!silo.stocks || silo.stocks.length === 0) continue;
        
        for (const stock of silo.stocks) {
          const typeAliment = stock.type;
          
          // Calculer stock actuel
          const stockInitial = stock.quantite || 0;
          const entrees = (data.entreesBat || [])
            .filter(e => e.batimentId === silo.id && e.typeStock === typeAliment)
            .reduce((sum, e) => sum + parseFloat(e.quantite || 0), 0);
          const sorties = (data.sortiesBat || [])
            .filter(s => s.batimentId === silo.id && s.typeStock === typeAliment)
            .reduce((sum, s) => sum + parseFloat(s.quantite || 0), 0);
          const rations = (data.rations || [])
            .filter(r => r.batimentId === silo.id && r.typeAliment === typeAliment)
            .reduce((sum, r) => sum + parseFloat(r.quantiteTotale || 0), 0);
          
          const stockActuel = stockInitial + entrees - sorties - rations;
          
          // Calculer moyenne des 5 derniers jours
          const cinqJoursAvant = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];
          const rationsRecentes = (data.rations || [])
            .filter(r => r.batimentId === silo.id && r.typeAliment === typeAliment && r.date >= cinqJoursAvant)
            .reduce((sum, r) => sum + parseFloat(r.quantiteTotale || 0), 0);
          
          const nombreJours = Math.min(5, (data.rations || [])
            .filter(r => r.batimentId === silo.id && r.typeAliment === typeAliment && r.date >= cinqJoursAvant)
            .map(r => r.date)
            .filter((v, i, a) => a.indexOf(v) === i).length);
          
          const moyenneQuotidienne = nombreJours > 0 ? rationsRecentes / nombreJours : 0;
          const estimationJours = moyenneQuotidienne > 0 ? Math.floor(stockActuel / moyenneQuotidienne) : 999;
          
          // Alerte si stock < 5 jours de consommation
          if (estimationJours <= 5 && moyenneQuotidienne > 0) {
            notifications.push({
              title: '⚠️ ' + silo.nom + ' - ' + typeAliment,
              body: 'Rupture estimée dans ' + estimationJours + ' jour' + (estimationJours > 1 ? 's' : '') + ' (stock: ' + stockActuel.toFixed(0) + ' kg)'
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
      
      // ===== CALCULER STOCKS SILOS =====
      const stocksInfo = [];
      const silos = (data.batiments || []).filter(b => b.type === 'Silos');
      
      for (const silo of silos) {
        if (!silo.stocks || silo.stocks.length === 0) continue;
        
        for (const stock of silo.stocks) {
          const typeAliment = stock.type;
          
          // Calculer stock actuel
          const stockInitial = stock.quantite || 0;
          const entrees = (data.entreesBat || [])
            .filter(e => e.batimentId === silo.id && e.typeStock === typeAliment)
            .reduce((sum, e) => sum + parseFloat(e.quantite || 0), 0);
          const sorties = (data.sortiesBat || [])
            .filter(s => s.batimentId === silo.id && s.typeStock === typeAliment)
            .reduce((sum, s) => sum + parseFloat(s.quantite || 0), 0);
          const rations = (data.rations || [])
            .filter(r => r.batimentId === silo.id && r.typeAliment === typeAliment)
            .reduce((sum, r) => sum + parseFloat(r.quantiteTotale || 0), 0);
          
          const stockActuel = stockInitial + entrees - sorties - rations;
          
          // Calculer moyenne des 7 derniers jours
          const septJoursAvant = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
          const rationsRecentes = (data.rations || [])
            .filter(r => r.batimentId === silo.id && r.typeAliment === typeAliment && r.date >= septJoursAvant)
            .reduce((sum, r) => sum + parseFloat(r.quantiteTotale || 0), 0);
          
          const nombreJours = Math.min(7, (data.rations || [])
            .filter(r => r.batimentId === silo.id && r.typeAliment === typeAliment && r.date >= septJoursAvant)
            .map(r => r.date)
            .filter((v, i, a) => a.indexOf(v) === i).length);
          
          const moyenneQuotidienne = nombreJours > 0 ? rationsRecentes / nombreJours : 0;
          const estimationJours = moyenneQuotidienne > 0 ? Math.floor(stockActuel / moyenneQuotidienne) : 999;
          
          stocksInfo.push({
            silo: silo.nom,
            aliment: typeAliment,
            stock: stockActuel,
            moyenne: moyenneQuotidienne,
            jours: estimationJours
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
          
          stocks.forEach((s, idx) => {
            if (idx > 0) body += '\n';
            body += s.aliment + ' ' + s.stock.toFixed(0) + 'kg';
            
            if (s.jours >= 999) {
              body += ', pas de conso récente';
            } else {
              body += ', rupture dans ' + s.jours + 'j';
            }
          });
          
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