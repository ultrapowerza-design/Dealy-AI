# Dealy AI Assistant

## Run it locally
1. Rename `.env.example` to `.env` and put your Groq key in it.
2. `npm install`
3. `npm start`, then open http://localhost:3000

Node reads `.env` only at start-up, so restart after changing it.

## Folder layout
```
server.js  products.js  chat.js  limiter.js  logger.js  knowledge.js
package.json  package-lock.json  .env  .gitignore
public/   index.html  app.js  extra.css  styles.css  widget.js  logo.png
```
(Use a lowercase `public` folder.)

## What each piece does
- **products.js** searches your WooCommerce store live (prices, stock, links). Test it in a browser:
  https://dealy.co.za/wp-json/wc/store/v1/products?search=router&per_page=3
  If you see product data, it works. If you get an error page, tell your web developer
  the WooCommerce Store API is blocked.
- **limiter.js** and the message-length limit stop abuse (10 messages/minute and 150/day per visitor).
- **logger.js** saves chats to `logs/chats.jsonl`. Read them at
  `/admin/logs` by sending your admin key in a header (not in the URL), for example:
  `curl -H "x-admin-key: YOUR_ADMIN_KEY" "https://YOUR-CHAT-DOMAIN/admin/logs?followup=1"`
  (`followup=1` shows chats the bot could not fully answer). Emails and phone numbers typed by customers are masked,
  and entries older than `LOG_RETENTION_DAYS` (default 60) are deleted automatically.
- **widget.js** is the floating bubble for dealy.co.za.
- **knowledge.js** is the bot's only source of facts. Add real policies there (warranty, opening hours)
  and nothing you are unsure of.

## Stock levels
Without keys the bot only knows "In stock" / "Sold Out". For real quantities:
1. WordPress admin > WooCommerce > Settings > Advanced > REST API > **Add key**.
   Description "Dealy chatbot", Permissions **Read**. Create the key under a **dedicated low-privilege user**
   (not your main admin), because a Read key can see everything that user can see, including orders.
2. Copy the Consumer key (`ck_...`) and Consumer secret (`cs_...`) into `.env` as
   `WC_CONSUMER_KEY` and `WC_CONSUMER_SECRET` (and into your host's environment variables). Restart.
3. WooCommerce only has a number for products with **Manage stock** ticked (product > Inventory tab).
   Products without it still show In stock / Sold Out.
4. `STOCK_CAP=20` makes anything above 20 show as "20+". Set `STOCK_CAP=0` to show exact numbers.

Keys are sent in the Authorization header only. If your host strips that header and you get 401/403, ask your host
to allow it. As a last resort you can set `WC_ALLOW_QUERY_AUTH=1` (keys then travel in the URL and can appear in logs).
Rotate the keys every few months.

Keys stay on the server and are never sent to the browser. Never paste them into a chat or commit them to Git.
If the keys are wrong or the call fails, the bot quietly falls back to the public data.

## Put it on your website
Deploy (below), then add this to the site footer. In WordPress, a plugin such as
"WPCode" or "Insert Headers and Footers" is safer than editing theme files:

    <script src="https://YOUR-CHAT-DOMAIN/widget.js" defer></script>

Add `data-position="left"` if it clashes with your existing live-chat button.

## Deploy (e.g. Render)
- Build command: `npm install`   Start command: `npm start`
- Environment variables: `GROQ_API_KEY`, `NODE_ENV=production`, `ADMIN_KEY`, optional `WHATSAPP_NUMBER`
- Free plans sleep when idle and erase `logs/` on redeploy. For permanent logs use a paid plan with a disk.

## Safety limits (all optional environment variables)
- `GLOBAL_DAILY_MAX` (default 3000): total chat messages per day across all visitors.
- `MAX_PRODUCT_LOOKUPS_PER_MIN` (default 40): uncached store lookups per minute across all visitors.
- `LOG_RETENTION_DAYS` (default 60), `STOCK_CAP` (default 20), `WC_ALLOW_QUERY_AUTH` (default off).
- The bot runs at most 2 tool calls per step. Also set a spend limit in the Groq console.

## Privacy (POPIA)
Chats are stored. The page tells customers not to share passwords or card details and links to your
privacy policy. Mention chat logging in that policy.

## Not included
Order-status lookups. They need your WooCommerce API keys and a way to verify the customer.
