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

// TRACKING LINK
app.get('/click/', async (req, res) => {
  const campShortId = req.query.offer_id;
  const pubShortId = req.query.pub;

  if(!campShortId || !pubShortId) return res.status(400).send('Missing params');

  const { data: camp } = await sb.from('campaigns').select('*').eq('short_id', campShortId).eq('status','active').single();
  if (!camp) return res.status(404).send('Offer not found');

  const { data: pub } = await sb.from('publishers').select('*').eq('short_id', pubShortId).eq('status','active').single();
  if (!pub) return res.status(404).send('Publisher not found');

  const clickId = `${campShortId}_${pubShortId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const ua = req.headers['user-agent'] || '';
  const device = /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop';
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

  let { data: link } = await sb.from('affiliate_links').select('*').eq('publisher_id', pub.id).eq('campaign_id', camp.id).single();
  if (!link) {
    const { data: newLink } = await sb.from('affiliate_links').insert({
      publisher_id: pub.id, campaign_id: camp.id,
      short_code: `${campShortId}-${pubShortId}`, sub_id: null
    }).select().single();
    link = newLink;
  }

  await sb.from('clicks').insert({
    click_id: clickId, link_id: link?.id,
    publisher_id: pub.id, campaign_id: camp.id,
    ip, device, browser: ua.slice(0,100), sub_id: null
  });

  const sep = camp.offer_url?.includes('?') ? '&' : '?';
  const targetUrl = camp.offer_url + sep + 'aff_click_id=' + clickId;
  console.log(`CLICK: ${clickId} | ${camp.name} | ${pub.name}`);
  res.redirect(302, targetUrl);
});

// POSTBACK FROM ADVERTISER
app.get('/postback', async (req, res) => {
  const { click_id, event, payout } = req.query;
  console.log(`POSTBACK: click_id=${click_id} event=${event} payout=${payout}`);
  if (!click_id) return res.status(400).send('Missing click_id');

  const { data: click } = await sb.from('clicks').select('*').eq('click_id', click_id).single();
  if (!click) return res.status(404).send('Click not found');

  const { data: camp } = await sb.from('campaigns').select('*').eq('id', click.campaign_id).single();
  if (!camp) return res.status(404).send('Campaign not found');

  const eventName = event || 'install';
  const events = camp.events || [];
  const matchedEvent = events.find(e => e.name.toLowerCase() === eventName.toLowerCase());
  const finalPayout = parseFloat(payout) || matchedEvent?.payout || 0;

  const { data: conv } = await sb.from('conversions').insert({
    click_id, publisher_id: click.publisher_id,
    campaign_id: click.campaign_id,
    event_name: eventName, payout: finalPayout, status: 'approved'
  }).select().single();

  const { data: pub } = await sb.from('publishers').select('balance,total_earned,name').eq('id', click.publisher_id).single();
  await sb.from('publishers').update({
    balance: (pub.balance||0) + finalPayout,
    total_earned: (pub.total_earned||0) + finalPayout
  }).eq('id', click.publisher_id);

  console.log(`CONVERSION: ${eventName} | ${pub.name} | Rs.${finalPayout}`);

  const { data: pbs } = await sb.from('postbacks').select('*')
    .eq('publisher_id', click.publisher_id)
    .eq('campaign_id', click.campaign_id)
    .eq('event_name', eventName)
    .eq('status', 'active');

  for (const pb of pbs || []) {
    let firedUrl = pb.postback_url
      .replace(/{aff_click_id}/g, click_id)
      .replace(/{payout}/g, finalPayout)
      .replace(/{event_name}/g, eventName)
      .replace(/{offer_id}/g, camp.short_id||'')
      .replace(/{device}/g, click.device||'')
      .replace(/{ip}/g, click.ip||'')
      .replace(/{affsub}/g, click.sub_id||'')
      .replace(/{affsub2}/g, '')
      .replace(/{affsub3}/g, '')
      .replace(/{affsub4}/g, '')
      .replace(/{affsub5}/g, '')
      .replace(/{click_time}/g, click.clicked_at||'')
      .replace(/{track_time}/g, new Date().toISOString())
      .replace(/{browser}/g, click.browser||'')
      .replace(/{gaid}/g, '')
      .replace(/{idfa}/g, '')
      .replace(/{os}/g, '')
      .replace(/{sub_aff_id}/g, pub.short_id||'');

    let responseCode = 0, status = 'failed';
    try {
      const r = await axios.get(firedUrl, { timeout: 5000 });
      responseCode = r.status; status = 'success';
    } catch(e) {
      responseCode = e.response?.status || 0;
    }

    await sb.from('postback_logs').insert({
      publisher_id: click.publisher_id,
      conversion_id: conv?.id,
      fired_url: firedUrl,
      response_code: responseCode,
      status
    });
    console.log(`PB FIRED: ${firedUrl} → ${responseCode}`);
  }
  res.send('OK');
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/publisher.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.listen(process.env.PORT || 3000, () => console.log('CashFlix Running!'));
