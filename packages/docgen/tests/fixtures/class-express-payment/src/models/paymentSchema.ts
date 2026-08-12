import { Schema, model } from 'mongoose';

const PaymentSchema = new Schema({
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
});

const paymentSchema = new Schema({
  externalId: { type: String, required: true },
});

export const Payment = model('Payment', PaymentSchema);
export const payment = model('payment', paymentSchema);
