const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();

// ===== FONCTION PRINCIPALE - TOUS LES JOURS À 8H =====
exports.envoyerNotificationsQuotidiennes = onSchedule({
  schedule: '* * * * *',
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
        let titre = 'Aujourd\'hui ' + evt.titre;
        if (evt.heure) titre += ' à ' + evt.heure;
        
        notifications.push({
          title: '📅 ' + titre,
          body: evt.description || 'Consultez votre planning'
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

// ===== FONCTION UTILITAIRE =====
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const jour = String(date.getDate()).padStart(2, '0');
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  return jour + '/' + mois;
}