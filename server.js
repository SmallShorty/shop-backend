require('dotenv').config();
const express = require('express');
const { Client } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors')

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use(cors({
  origin: 'http://localhost:5174',
  credentials: true
}))

// Подключение к PostgreSQL
const client = new Client({
  user:     process.env.POSTGRES_USER,
  host:     process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port:     process.env.POSTGRES_PORT,
});
client.connect()
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error('Database connection error', err.stack));

// ----------------- Multer для загрузки -----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.use('/uploads', express.static('uploads'));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ----------------- Маршрут: все товары -----------------
app.get('/products', async (req, res) => {
  try {
    const { rows } = await client.query(`
      SELECT
        p.id,
        p.code,
        c.name   AS category,
        t.name   AS type,
        b.name   AS brand,
        p.name,
        p.description,
        p.price,
        p.discount_percent AS sale,
        COALESCE(AVG(r.rating), 0)::NUMERIC(2,1) AS average_rating,
        json_agg(DISTINCT s.label)        AS sizes,
        json_agg(DISTINCT pi.url)         AS images
      FROM products p
      JOIN categories c ON p.category_id = c.id
      JOIN types t       ON p.type_id     = t.id
      JOIN brands b      ON p.brand_id    = b.id
      LEFT JOIN product_reviews r ON r.product_id = p.id
      LEFT JOIN product_sizes   ps ON ps.product_id = p.id
      LEFT JOIN sizes s         ON ps.size_id      = s.id
      LEFT JOIN product_images  pi ON pi.product_id = p.id
      GROUP BY p.id, c.name, t.name, b.name
      ORDER BY p.id;
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список товаров' });
  }
});

// ----------------- Маршрут: детали товара -----------------
app.get('/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Базовая информация
    const productQ = await client.query(`
      SELECT
        p.id,
        p.code,
        c.name   AS category,
        t.name   AS type,
        b.name   AS brand,
        p.name,
        p.description,
        p.price,
        p.discount_percent AS sale,
        p.created_at,
        p.updated_at
      FROM products p
      JOIN categories c ON p.category_id = c.id
      JOIN types t       ON p.type_id     = t.id
      JOIN brands b      ON p.brand_id    = b.id
      WHERE p.id = $1
    `, [id]);
    if (productQ.rows.length === 0) {
      return res.status(404).json({ error: 'Товар не найден' });
    }
    const product = productQ.rows[0];

    // Размеры
    const sizesQ = await client.query(`
      SELECT s.label
      FROM product_sizes ps
      JOIN sizes s ON ps.size_id = s.id
      WHERE ps.product_id = $1
    `, [id]);
    const sizes = sizesQ.rows.map(r => r.label);

    // Изображения
    const imagesQ = await client.query(`
      SELECT url, alt_text
      FROM product_images
      WHERE product_id = $1
    `, [id]);

    // Отзывы
    const reviewsQ = await client.query(`
      SELECT rating, comment, created_at
      FROM product_reviews
      WHERE product_id = $1
      ORDER BY created_at DESC
    `, [id]);

    res.json({
      ...product,
      sizes,
      images: imagesQ.rows,
      reviews: reviewsQ.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить детали товара' });
  }
});

// ----------------- Маршрут: загрузка картинки -----------------
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не загружен' });
  }
  res.json({
    url: `/uploads/${req.file.filename}`,
    filename: req.file.filename
  });
});

// ----------------- Маршрут: все категории -----------------
app.get('/categories', async (req, res) => {
  try {
    const { rows } = await client.query('SELECT id, name FROM categories ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список категорий' });
  }
});

// ----------------- Маршрут: все бренды -----------------
app.get('/brands', async (req, res) => {
  try {
    const { rows } = await client.query('SELECT id, name FROM brands ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список брендов' });
  }
});

// ----------------- Маршрут: все типы -----------------
app.get('/types', async (req, res) => {
  try {
    const { rows } = await client.query('SELECT id, name FROM types ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список типов' });
  }
});

// ----------------- Маршрут: все размеры -----------------
app.get('/sizes', async (req, res) => {
  try {
    const { rows } = await client.query('SELECT id, label FROM sizes ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список размеров' });
  }
});

// ----------------- Маршрут: создание нового товара -----------------
app.post('/createProduct', upload.array('images'), async (req, res) => {
  const {
    code,
    name,
    description,
    price,
    discount_percent,
    categoryId,
    typeId,
    brandId,
    sizes,
  } = req.body;

  if (!code || !name || !price || !categoryId || !typeId || !brandId) {
    return res.status(400).json({ error: 'Обязательные поля отсутствуют' });
  }

  try {
    await client.query('BEGIN');

    // 1. Вставка основного товара
    const insertProductQuery = `
      INSERT INTO products
        (code, name, description, price, discount_percent, category_id, type_id, brand_id, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING id
    `;
    const productResult = await client.query(insertProductQuery, [
      code,
      name,
      description || '',
      price,
      discount_percent || 0,
      categoryId,
      typeId,
      brandId,
    ]);

    const productId = productResult.rows[0].id;

    // 2. Вставка размеров
    if (sizes && sizes.length > 0) {
      const sizeValues = sizes.map(size => [productId, size]);
      await client.query(
        `INSERT INTO product_sizes (product_id, size_id) VALUES ${sizeValues.map((_, i) => `($${i*2+1}, $${i*2+2})`).join(', ')}`,
        sizeValues.flat()
      );
    }

    // 3. Вставка изображений
    if (req.files && req.files.length > 0) {
      const imageValues = req.files.map(file => [productId, file.path, file.filename]);
      await client.query(
        `INSERT INTO product_images (product_id, url, alt_text) VALUES ${imageValues.map((_, i) => `($${i*3+1}, $${i*3+2}, $${i*3+3})`).join(', ')}`,
        imageValues.flat()
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Товар создан', id: productId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ошибка при создании товара' });
  }
});

// ----------------- Запуск сервера -----------------
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
