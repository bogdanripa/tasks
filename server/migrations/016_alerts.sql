-- Alerts outside the inbox: a person's own Telegram bot and chat, for things that need them.
alter table accounts add column telegram_bot_token_enc text;
alter table accounts add column telegram_chat_id text;
