import mongoose, { Schema } from 'mongoose';
const userSchema = new Schema({ nickname: String });
mongoose.model('user', userSchema);
