const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const UAParser = require('ua-parser-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── TRACKING LINK ───────────────────────────
app.get('/track/:code', async (req, res) => {
  const { code } = req.params;
  const ua = new UAParser(req.headers['user-agent']);

  const { data: link } = await sb
    .from('affiliate_links')
    .select('*, campaigns(*)')
    .eq('short_code', code)
    .single();

  if (!link) return res.status(404).send('Link not found');

  const clickId = crypto.randomUUID();

  await sb.from('clicks').insert({
    click_id: clickId,
    link_id: link.id,
    publisher_id: link.publisher_id,
    campaign_id: link.campaign_id,
    ip: req.headers['x-forwarded-for'] || req.ip,
    device: ua.getDevice().type || 'desktop',
    browser: ua.getBrowser().name || 'unknown',
    sub_id: link.sub_id
  });

  const targetUrl = link.campaigns.target_url +
    '?click_id=' + clickId +
    (link.sub_id ? '&sub=' + link.sub_id : '');

  res.redirect(targetUrl);
});

// ─── POSTBACK FROM ADVERTISER ─────────────────
app.get('/postback', async (req, res) => {
  const { click_id, event, payout } = req.query;

  if (!click_id) return res.status(400).send('Missing click_id');

  const { data: click } = await sb
    .from('clicks')
    .select('*, affiliate_links(*)')
    .eq('click_id', click_id)
    .single();

  if (!click) return res.status(404).send('Click not found');

  const { data: camp } = await sb
    .from('campaigns')
    .select('*')
    .eq('id', click.campaign_id)
    .single();

  const eventName = event || 'install';
  const payoutMap = {
    install: camp.payout_install,
    trial: camp.payout_trial,
    lead: camp.payout_lead,
    purchase: camp.payout_purchase
  };
  const finalPayout = parseFloat(payout) || payoutMap[eventName] || 0;

  const { data: conv } = await sb.from('conversions').insert({
    click_id,
    publisher_id: click.publisher_id,
    campaign_id: click.campaign_id,
    event_name: eventName,
    payout: finalPayout,
    status: 'approved'
  }).select().single();

  // Publisher balance update
  const { data: pub } = await sb
    .from('publishers')
    .select('balance, total_earned')
    .eq('id', click.publisher_id)
    .single();

  await sb.from('publishers').update({
    balance: (pub.balance || 0) + finalPayout,
    total_earned: (pub.total_earned || 0) + finalPayout
  }).eq('id', click.publisher_id);

  // Publisher ka postback fire karo
  const { data: pbs } = await sb
    .from('postbacks')
    .select('*')
    .eq('publisher_id', click.publisher_id)
    .eq('campaign_id', click.campaign_id)
    .eq('event_name', eventName)
    .eq('status', 'active');

  for (const pb of pbs || []) {
    let url = pb.postback_url
      .replace('{aff_click_id}', click_id)
      .replace('{payout}', finalPayout)
      .replace('{event_name}', eventName)
      .replace('{offer_id}', click.campaign_id)
      .replace('{device}', click.device || '')
      .replace('{ip}', click.ip || '')
      .replace('{affsub}', click.sub_id || '')
      .replace('{click_time}', click.clicked_at || '');

    let code = 0, status = 'failed';
    try {
      const r = await axios.get(url, { timeout: 5000 });
      code = r.status; status = 'success';
    } catch(e) {
      code = e.response?.status || 0;
    }

    await sb.from('postback_logs').insert({
      publisher_id: click.publisher_id,
      conversion_id: conv.id,
      fired_url: url,
      response_code: code,
      status
    });
  }

  res.send('OK');
});

// ─── SERVE PANELS ────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/publisher.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

app.listen(process.env.PORT || 3000, () => console.log('AffTrack running!'));
