require('dotenv').config();


const express = require('express');
const app = express();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { MercadoPagoConfig, Payment } = require('mercadopago')
const crypto = require('crypto');

app.use(express.json());
app.use(cors());

const port = process.env.PORT || 5000;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Database connection
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.log(err));

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'usbc',
        public_id: (req, file) => file.fieldname + '_' + Date.now(),
    },
});

const upload = multer({ storage: storage });

// Define Product schema
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    description: String,
    imageUrls: [String],  // Updated to an array to hold multiple image URLs
});

const Product = mongoose.model('Product', productSchema);

// Define User schema
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
});

userSchema.pre('save', async function (next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});

userSchema.methods.comparePassword = function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

// API to check if the server is running
app.get('/', (req, res) => {
    res.send("Express App is Running");
});

// Create a new product
app.post('/api/products', async (req, res) => {
    try {
        const { name, price, description, imageUrls } = req.body; // Expect imageUrls as an array

        // Validate data
        if (!name || !price || !imageUrls || !Array.isArray(imageUrls)) {
            return res.status(400).json({ error: 'Name, price, and imageUrls are required' });
        }

        // Create and save the new product
        const product = new Product({
            name,
            price,
            description,
            imageUrls
        });
        
        await product.save();
        res.status(201).json(product);
    } catch (error) {
        console.error('Error adding product:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get all products
app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find();
        res.status(200).send(products);
    } catch (error) {
        res.status(500).send(error);
    }
});

// Get a single product by ID
app.get('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).send();
        }
        res.status(200).send(product);
    } catch (error) {
        res.status(500).send(error);
    }
});

// Update a product by ID
app.put('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!product) {
            return res.status(404).send();
        }
        res.status(200).send(product);
    } catch (error) {
        res.status(400).send(error);
    }
});

// Delete a product by ID
app.delete('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) {
            return res.status(404).send();
        }
        res.status(200).send(product);
    } catch (error) {
        res.status(500).send(error);
    }
});

// Endpoint to handle file uploads
app.post("/upload", upload.array('productImages', 6), (req, res) => {
    const imageUrls = req.files.map(file => file.path); // Extract image URLs from Cloudinary

    res.json({
        success: 1,
        imageUrls // Return an array of image URLs
    });
});

// Register a new user
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;

    // Validate data
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    try {
        const user = new User({ username, email, password });
        await user.save();
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.status(201).json({ token });
    } catch (error) {
        console.error('Error registering user:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Authenticate user and return a token
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    // Validate data
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const user = await User.findOne({ email });
        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.status(200).json({ token });
    } catch (error) {
        console.error('Error logging in user:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const client = new MercadoPagoConfig({
    accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN, // Replace with your access token
    options: { 
        timeout: 5000, 
        idempotencyKey: 'your_unique_idempotency_key' // Optional
    }
});
const payment = new Payment(client);

app.post('/create-checkout-session', async (req, res) => {
    const { items, payerEmail, shippingAddress } = req.body;

    try {
        const totalAmount = items.reduce((total, item) => total + (item.unit_price * item.quantity), 0);

        if (totalAmount <= 0) {
            throw new Error('Total amount must be greater than 0');
        }

        const body = {
            items: items.map(item => ({
                title: item.title || 'Product',
                quantity: item.quantity,
                unit_price: parseFloat(item.unit_price), // Ensure this is a number
                currency_id: 'ARS'
            })),
            payer: {
                email: payerEmail
            },
            back_urls: {
                success: 'https://rossousbchdmi.netlify.app/success',
                failure: 'https://rossousbchdmi.netlify.app/cancel',
                pending: 'https://yourapp.com/pending'
            },
            auto_return: 'approved',
            additional_info: JSON.stringify({
                shipping_address: shippingAddress
            })
        };

        const requestOptions = {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`
            }
        };

        const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            ...requestOptions,
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Failed to create payment preference: ${error.message}`);
        }

        const { id } = await response.json();

        if (!id) {
            throw new Error('Invalid response from Mercado Pago');
        }

        // Optionally create the order here if payment is successful
        await fetch('https://usbc-hdmi-backend.onrender.com/create-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                paymentId: id,
                shippingAddress,
                payerEmail,
                items
            }),
        });

        res.json({ id });
    } catch (error) {
        console.error('Error creating payment:', error.message);
        res.status(500).send('Server Error');
    }
});


const Order = mongoose.model("Order", {
    paymentId: {
        type: String,
        required: true
    },
    shippingAddress: {
        type: String,
        required: true
    },
    payerEmail: {
        type: String,
        required: true
    },
    items: [{
        title: String,
        quantity: Number,
        unit_price: Number,
    }],
    status: {
        type: String,
        default: 'pending', // Default status is 'pending'
    }
});


// Route Definition
app.get('/order-details/:paymentId', async (req, res) => {
    const { paymentId } = req.params;

    try {
        console.log(`Received request for paymentId: ${paymentId}`); // Debug log
        const order = await Order.findOne({ paymentId });
        if (!order) {
            console.log('Order not found'); // Debug log
            return res.status(404).send('Order not found');
        }

        res.json({
            id: order.id,
            shippingAddress: order.shippingAddress,
            // Include other order details as needed
        });
    } catch (error) {
        console.error('Error fetching order details:', error);
        res.status(500).send('Server Error');
    }
});

app.post('/create-order', async (req, res) => {
    const { paymentId, shippingAddress, payerEmail, items } = req.body;

    try {
        const newOrder = new Order({
            paymentId,
            shippingAddress,
            payerEmail,
            items
        });

        await newOrder.save();
        res.status(201).send('Order created successfully');
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).send('Server Error');
    }
});

const MERCADO_PAGO_SECRET = process.env.MERCADO_PAGO_WEBHOOK_SECRET;

app.post('/webhook', async (req, res) => {
    const signature = req.headers['x-mercadopago-signature'];
    const body = JSON.stringify(req.body);

    // Verify the signature
    const hmac = crypto.createHmac('sha256', MERCADO_PAGO_SECRET);
    const digest = hmac.update(body).digest('hex');

    if (signature !== digest) {
        console.log('Invalid signature');
        return res.status(400).send('Invalid signature');
    }

    // Process the webhook payload
    try {
        const payment = req.body;
        
        if (payment.type === 'payment') {
            const paymentId = payment.data.id;

            // Fetch payment info from Mercado Pago
            const paymentInfo = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: {
                    'Authorization': `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`
                }
            });

            const paymentData = await paymentInfo.json();

            // Update order status if payment is successful
            if (paymentData.status === 'approved') {
                await Order.findOneAndUpdate(
                    { paymentId },
                    { status: 'paid' }, 
                    { new: true }
                );
                console.log('Order updated to paid status');
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Server Error');
    }
});

app.listen(port, (error) => {
    if (!error) {
        console.log("Server running on port", port);
    } else {
        console.log("Error : " + error);
    }
});
