const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── TRACKING LINK ───────────────────────────
// Format: /track/o{campaign_short_id}/pub-{publisher_short_id}
// Example: /track/o88/pub-1
app.get('/track/:offerId/:pubId', async (req, res) => {
  const { offerId, pubId } = req.params;

  // offerId = "o88" → campaign short_id = "88"
  // pubId = "pub-1" → publisher short_id = "1"
  const campShortId = offerId.replace('o', '');
  const pubShortId = pubId.replace('pub-', '');

  // Campaign dhundo
  const { data: camp } = await sb
    .from('campaigns')
    .select('*')
    .eq('short_id', campShortId)
    .eq('status', 'active')
    .single();

  if (!camp) return res.status(404).send('Campaign not found or paused');

  // Publisher dhundo
  const { data: pub } = await sb
    .from('publishers')
    .select('*')
    .eq('short_id', pubShortId)
    .eq('status', 'active')
    .single();

  if (!pub) return res.status(404).send('Publisher not found');

  // Unique click ID banao
  const clickId = `${campShortId}_${pubShortId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

  // Device detect karo
  const ua = req.headers['user-agent'] || '';
  const device = /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop';
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

  // Affiliate link dhundo ya banao
  let { data: link } = await sb
    .from('affiliate_links')
    .select('*')
    .eq('publisher_id', pub.id)
    .eq('campaign_id', camp.id)
    .single();

  if (!link) {
    const { data: newLink } = await sb
      .from('affiliate_links')
      .insert({
        publisher_id: pub.id,
        campaign_id: camp.id,
        short_code: `${campShortId}-${pubShortId}`,
        sub_id: null
      })
      .select()
      .single();
    link = newLink;
  }

  // Click save karo
  await sb.from('clicks').insert({
    click_id: clickId,
    link_id: link?.id,
    publisher_id: pub.id,
    campaign_id: camp.id,
    ip,
    device,
    browser: ua.slice(0, 100),
    sub_id: null
  });

  // User ko advertiser ke URL pe bhejo with click_id
  const targetUrl = camp.target_url +
    (camp.target_url.includes('?') ? '&' : '?') +
    'click_id=' + clickId +
    '&pub=' + pubShortId;

  console.log(`CLICK: ${clickId} | Camp: ${camp.name} | Pub: ${pub.name} | IP: ${ip}`);

  res.redirect(302, targetUrl);
});

// ─── POSTBACK FROM ADVERTISER ─────────────────
// INRFlash ya koi bhi advertiser yahan fire karega
// Example: /postback?click_id=88_1_1234_abc&event=install&payout=6.38
app.get('/postback', async (req, res) => {
  const { click_id, event, payout } = req.query;

  console.log(`POSTBACK RECEIVED: click_id=${click_id} event=${event} payout=${payout}`);

  if (!click_id) return res.status(400).send('Missing click_id');

  // Click dhundo
  const { data: click } = await sb
    .from('clicks')
    .select('*, affiliate_links(*)')
    .eq('click_id', click_id)
    .single();

  if (!click) {
    console.log(`POSTBACK ERROR: click_id ${click_id} not found`);
    return res.status(404).send('Click not found');
  }

  // Campaign dhundo
  const { data: camp } = await sb
    .from('campaigns')
    .select('*')
    .eq('id', click.campaign_id)
    .single();

  if (!camp) return res.status(404).send('Campaign not found');

  // Event aur payout decide karo
  const eventName = event || 'install';
  const payoutMap = {
    install: camp.payout_install || 0,
    trial: camp.payout_trial || 0,
    lead: camp.payout_lead || 0,
    purchase: camp.payout_purchase || 0
  };
  const finalPayout = parseFloat(payout) || payoutMap[eventName] || 0;

  // Conversion save karo
  const { data: conv } = await sb
    .from('conversions')
    .insert({
      click_id,
      publisher_id: click.publisher_id,
      campaign_id: click.campaign_id,
      event_name: eventName,
      payout: finalPayout,
      status: 'approved'
    })
    .select()
    .single();

  // Publisher balance update karo
  const { data: pubData } = await sb
    .from('publishers')
    .select('balance, total_earned, name')
    .eq('id', click.publisher_id)
    .single();

  await sb.from('publishers').update({
    balance: (pubData.balance || 0) + finalPayout,
    total_earned: (pubData.total_earned || 0) + finalPayout
  }).eq('id', click.publisher_id);

  console.log(`CONVERSION: ${eventName} | Publisher: ${pubData.name} | Payout: ₹${finalPayout}`);

  // Publisher ka postback fire karo
  const { data: pbs } = await sb
    .from('postbacks')
    .select('*')
    .eq('publisher_id', click.publisher_id)
    .eq('campaign_id', click.campaign_id)
    .eq('event_name', eventName)
    .eq('status', 'active');

  for (const pb of pbs || []) {
    let firedUrl = pb.postback_url
      .replace(/{aff_click_id}/g, click_id)
      .replace(/{payout}/g, finalPayout)
      .replace(/{event_name}/g, eventName)
      .replace(/{offer_id}/g, click.campaign_id)
      .replace(/{device}/g, click.device || '')
      .replace(/{ip}/g, click.ip || '')
      .replace(/{affsub}/g, click.sub_id || '')
      .replace(/{click_time}/g, click.clicked_at || '');

    let responseCode = 0;
    let status = 'failed';

    try {
      const r = await axios.get(firedUrl, { timeout: 5000 });
      responseCode = r.status;
      status = 'success';
      console.log(`POSTBACK FIRED: ${firedUrl} → ${responseCode}`);
    } catch (e) {
      responseCode = e.response?.status || 0;
      console.log(`POSTBACK FAILED: ${firedUrl} → ${e.message}`);
    }

    await sb.from('postback_logs').insert({
      publisher_id: click.publisher_id,
      conversion_id: conv?.id,
      fired_url: firedUrl,
      response_code: responseCode,
      status
    });
  }

  res.send('OK');
});

// ─── SERVE PANELS ────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/publisher.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

app.listen(process.env.PORT || 3000, () => {
  console.log('CashFlix Affiliate Server Running!');
});
