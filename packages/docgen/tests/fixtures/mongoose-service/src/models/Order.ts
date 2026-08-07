import mongoose, { Schema } from 'mongoose';

const OrderSchema: Schema = new Schema(
  {
    orderNo: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items: [{ sku: { type: String }, qty: { type: Number } }],
    tags: [String],
    status: { type: String, default: 'NEW' },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

OrderSchema.index({ orderNo: 1 }, { unique: true });

export const Order = mongoose.model('Order', OrderSchema);
