import mongoose, { Schema } from 'mongoose';
const UserSchema = new Schema({ phone: String });
mongoose.model('User', UserSchema);
