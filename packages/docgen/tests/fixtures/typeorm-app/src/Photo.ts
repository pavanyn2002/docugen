import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToMany } from 'typeorm';
import { Album } from './Album';

@Entity('photos')
export class Photo {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', unique: true })
  slug!: string;

  @Column({ nullable: true })
  caption?: string;

  @ManyToOne(() => Album, (album) => album.photos)
  album!: Album;
}
